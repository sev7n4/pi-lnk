# SSE 事件一等化 P1c 清债刀——账本投影 + metadata 双写消除（实施计划）

> 母计划：`2026-11-11-sse-session-resume-p0-p2.md` §2.2「P1c（清债）：消除 AgentMessage.metadata 内的大 JSON 双写（保留最小兼容字段），统一 envelope，废弃局部 seq 排序（agentTrace.ts 切 gSeq）」。
> 上游刀：P1a PR-A #837（帧契约）/ PR-B #840（AgentEvent 账本）/ P1b #843（前端 snapshot 收敛）。本文按 2026-11-11 实施前真值核对（R1–R8）改写母计划 P1c 范围。

## 0. 债的量化（生产实证，2026-11-11 只读快照）

| 指标 | 值 |
|---|---|
| assistant 消息总数 | 10225 |
| 带 `executionEvents` 的行 | 1075（max **530,873 字节**，avg 17KB） |
| 不带 `executionEvents` 的行 metadata | max 1,517 字节（executionTrace/presentation 体量无害） |
| 带 `waiting_user` 的行 | 298 |

结论：**债的主体 = executionEvents**。收缩后 metadata 上限回落到「waiting_user + turn_settled + 合成事件」量级（≤ 数 KB）。

## 1. 真值核对结论（R1–R8，全部回代码核实）

- **R1（gSeq 已贯通写面）**：`pushTraceEvent` 恒写 `gSeq: currentPiEvent?.seq`（pi-runtime 对 run 内事件兜底打戳，session-manager.ts:3219）；账本 unique `(threadId, gSeq, sSeq)`。局部 `seq`（traceSeq）与账本 `sSeq` **共用同一计数器** ⇒ 单回合内两存储按 seq/sSeq 归并排序天然一致。
- **R2（metadata.executionEvents 读者面）**：服务端仅 waiting_user 三处（pending 查找 ~L2218 / resolved 追加 ~L2270 / 清除 ~L2314，读 `metadata.executionEvents`）；前端历史重放全部读 `meta.executionEvents`（stores/agent.ts ~L959–1115：turn_settled 探测 / executionTrace 重放 / timeline 重放 / 节点图+SVG 卡重放）。
- **R3（读时 enrichment 可行）**：`getMessages` 返回原始行（metadata JSON 字符串直出，controller `chat/user/messages` 透传，无 DTO 裁剪）⇒ **服务端读时注入派生 executionEvents 可让前端读路径零改动**（母计划 P1b 原文「由事件表投影生成，保留兼容读」的正解）。
- **R4（账本缺 messageIndex）**：`AgentEvent` 无 messageIndex 列，且 `message_end` 不是 trace 事件（不进账本）⇒ 前端块归属无法从账本重建 ⇒ 需 **additive 迁移加列** + `appendAgentEvent` 写 `ev.messageIndex`（现成可用，pushTraceEvent 已写）。
- **R5（排序切 gSeq 已完成）**：turnTimeline.ts ~L1191 `sortKey = e.gSeq ?? e.seq`（TURN-IDENTITY P0-1 落地）+ `mergeExecutionEvents`（turn-ledger.ts，按 gSeq 归并去重、无 gSeq 保序）现成 ⇒ 母计划「agentTrace 切 gSeq」**无剩余代码债**。
- **R6（合成事件面）**：无 gSeq 事件 = 流外结算块（currentPiEvent 为空的边界）+ 旧 runtime/非流式合成；正常回合全部事件带 gSeq。
- **R7（turn_settled 的健壮性耦合）**：结算块 `turn_settled` 经**awaited 的 finalizeTurn** 落 metadata（权威终态），而账本是 fire-and-forget fail-open。前端 turn_settled 探测（L959/L1115）门控已结算 UI 态 ⇒ **turn_settled 必须保留 metadata 直写**（若改账本唯一真源，账本写失败窗口会把已结算回合显示为运行中）。waiting_user 同理（其状态机读者只读 metadata，P2 PendingInterruption 表接管前不可动）。
- **R8（isLedgerComplete 耦合）**：两处 finalizeTurn 以 `eventCount: executionEvents.length` 判账本完整性——收缩后数组只存保留集，**必须改用 traceSeq 总计数**，否则「半路接入且只见到保留集事件」的流会被误判 complete（N4 冒充全量）。

## 2. 设计（P1c-A 读时投影 + P1c-B 写面分流，**同刀原子**——收缩使前端历史重放依赖 enrichment，拆刀会出现读缺口窗口）

### 2.1 P1c-A：读时 enrichment（前端零改动）

1. **Schema additive**：`AgentEvent` 加 `messageIndex Int @default(0)` + `@@index([threadId, runId])`（enrichment 查询走索引）；`appendAgentEvent` payload 写 `messageIndex: ev.messageIndex ?? 0`。
2. **投影函数**（agent.service.ts 新导出纯函数，便于测试）：`projectEventsFromLedger(rows, metadataLeftovers)` —— 账本行转 `PersistedExecutionEvent`（`data` JSON.parse、`sSeq→seq`、`gSeq/ts/messageIndex` 透传），与 metadata 残留事件（waiting_user/turn_settled/合成）合并，复用 `mergeExecutionEvents` 归并（gSeq 优先、seq 保序）。
3. **enrichment 挂点**：`getMessages` 分页后对**最终页** assistant 行执行——`runId` 非空且解析后 metadata **无 executionEvents 键**（新收缩行）⇒ 单查询 `agentEvent.findMany({ threadId, runId: { in: 窗口 runIds }, orderBy [gSeq, sSeq] })`，按 runId 分组投影，注入**响应副本** `metadata.executionEvents`（重新 stringify，不落库）。老行（有 executionEvents）与 runId 为 NULL 行直通零成本。
   - 阴性保证：enrichment 只加键不改键；账本空（写失败/旧线程）⇒ 响应 metadata 与 DB 原样一致（不注入空数组，维持「键不出现」纪律）。
   - 语义保真：账本只含本流所见事件（含 partial/truncated 场景）⇒ 投影结果与旧行为「重放所见前缀」一致，flags（partial/gapFrom/truncated）照旧随 metadata 透传。

### 2.2 P1c-B：写面分流收缩

`pushTraceEvent` 单点分流（两通道 finalize 路径共用，天然一致）：

```
保留集（仍进 executionEvents 数组 → metadata）：
  ev.gSeq === undefined（合成事件）
  || ev.type === 'waiting_user'   // R7：状态机读者只在 metadata，P2 接管后摘除
  || ev.type === 'turn_settled'   // R7：awaited 权威终态，前端探测健壮性
其余（带 gSeq 的 text/tool_call/tool_result/thinking/canvas/task_list/turn_usage/plan_proposed…）：
  只进账本（appendAgentEvent），不进数组
```

- `pushTraceEvent` **返回值不变**（调用点 `pushTraceEvent(...).data` 与 `const settledData = ...` 依赖）。
- **R8 修复**：两处 `LedgerCapture.eventCount` 从 `executionEvents.length` 改为 `traceSeq`（总推送计数，语义=「本流见到的全部事件数」不变式）。
- buildTurnMetadata / finalizeTurn / detached 路径**零改动**（数组天然只剩保留集）。
- metadata 键形态：新行仍可能带 executionEvents（保留集非空时），无保留集时键不出现（既有纪律）。

### 2.3 已知约束（记录不修）

- **shadow 流 sSeq 对齐假设**：并入在跑 run 的 shadow 流也经漏斗写账本，其 traceSeq 与 owner 流对齐依赖「同一 pi 事件序列」假设；若两流所见事件集分歧，可能以不同 sSeq 写入同 gSeq 事件（PR-B 既有行为，非本刀引入）。后续刀可收紧为 owner-only 写者。
- 账本 `ts` 用 `ev.ts ?? Date.now()`，与 metadata 原值同源；enrichment 还原为 epoch ms。

## 3. 测试判据（全部可失败 + 变异自检 RED→还原）

| # | 用例 | 判据 | 变异自检 |
|---|---|---|---|
| T1 | 写面分流：模拟带 gSeq 的全型事件流 | 数组/落库 metadata 仅含 waiting_user+turn_settled+合成事件；账本含全量（text/tool/…逐条在） | 删分流条件 → metadata 重新变大 → RED |
| T2 | waiting_user 兼容回归 | pending 查找/resolved 追加/清除三读者对新行仍工作（既有 waiting_user 测试全绿不动） | — |
| T3 | turn_settled 权威：账本写失败（stub reject）回合 | metadata 仍含 turn_settled（awaited 直写），前端探测语义不回退 | 改走账本唯一真源 → RED |
| T4 | eventCount 修正：sawRunStart=false 且仅保留集事件（traceSeq=3, 数组=1） | partial=true 不误判 complete | 还原 `executionEvents.length` → RED |
| T5 | enrichment 投影：预置账本行（gSeq/sSeq/messageIndex/data）+ 新收缩行（metadata 无 executionEvents） | 响应 metadata.executionEvents == 投影期望（含 turn_settled 合并、seq 升序、data 还原） | 删注入 → RED |
| T6 | enrichment 阴性：老行（metadata 自带 executionEvents）与账本空新行 | 响应与 DB 原样一致（不注入/不改键） | — |
| T7 | S7 一致性反转：同回合「账本全量 ⊇ metadata 保留集」且保留集逐条存在于账本 | 差集符合收缩契约 | 破坏任一侧 → RED |
| T8 | messageIndex 落账：message_end 分段后的事件 | 账本行 messageIndex == 分段序（0/1/…） | 删 `ev.messageIndex` 透传 → RED |

回归面：`agent.service.eventLedger.test.ts`（S2–S7 按新契约修订）、turn-ledger 测试、waiting_user 全家、getMessages 既有测试；全量 src/agent 快照跑测。

## 4. No-Go 清单

- ❌ 前端直接消费 events API 投影（T1/T2/T3/T6/T7 原移交项）——enrichment 使前端零改动达成同目标；前端投影仅在 P2 后若需要「服务端无关投影」再立项。
- ❌ 摘除 waiting_user/turn_settled 的 metadata 直写（R7 健壮性边界，等 P2 PendingInterruption 表接管）。
- ❌ 账本 update 语义变更（append-only + 幂等 upsert 保持）。
- ❌ 存量 1075 行回填迁移（老行读 metadata 直通，无需迁移；账本回填无源数据不可行也不必要）。
- ❌ P2 一并实施（PendingInterruption 表 + 门生命周期是独立刀，规格随本 PR 落档，实现另行授权）。

## 5. P2 durable 待确认门（规格预告，随本刀落档实现另行授权）

目标：挂起确认门 durable 化——`PendingInterruption` 表（threadId, callId, status pending/answered/expired, questionJson, answerJson, expiresAt, CAS 翻转, 过期扫描, late answer 裁决 `adjudicateLateAnswer`, 重启存活），接管 waiting_user 的 metadata 状态机读者（P1c 保留集的最后一块），门 `expired` 后不再下发活卡片（P1c-6 判据形态见母计划 §2.3 P1c-1..6 表）。实现入口：现 waiting_user 三读者 + `runEventStream` waiting 检出点；state API `pendingInterruption` 预留位已就绪（getThreadResumeState 恒 null）。

## 6. 验收

- 全量 src/agent 快照跑测绿 + tsc 零新增 + CI 三 job 绿（含棘轮闸基线不变——本刀不加前端 deps 键）。
- 变异自检 T1/T3/T4/T5/T7/T8 各自精准 RED→还原。
- 合并后生产复测：新对话回合 metadata 长度显著回落（DB 实测 max/avg）+ 账本 messageIndex 列非全 0 + 新行历史重放（enrichment）抽验。
