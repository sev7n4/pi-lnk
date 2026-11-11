# 子代理结果回传：回合终态契约与 P0 止血设计规格

> 日期：2026-11-11　|　状态：**已拍板，待实施**　|　路径：architectural（brainstorming）
> 前置：`outputs/2026-11-11-subagent-result-delivery-diagnosis.md`（只读取证 + 根因）
> 代码基线：**真 master `62cd739c`（#843）**，`@earendil-works/pi-agent-core@0.99.2`；本地主仓 `5926ac72` 为 0.85.1 陈旧文档分支，**禁止作为改刀依据**
> 本文只定义规格与验收；实施计划见 `docs/superpowers/plans/2026-11-11-subagent-result-delivery.md`

---

## 1. 意图与成功标准

### 用户要什么（写回理解）

生产测试会话 `cmwbvfp4p000qrk01pch77w13` 中，主 agent 调用 `spawn_subagent` 后界面停在「派生子代理 ✓ 用时 0ms」，没有任何后续输出、没有报错、不知道发生了什么，还被扣 1 积分。要的不是"加个指标看清一点"，而是：**从 agent 工程角度修正「完成」的判定与结果回传契约，让中断诚实可见、未交付不收费、界面不说谎，并把修复接到上游已有原语而非再造轮子。**

### 成功标准（可验收）

| # | 标准 | 判据 |
|---|---|---|
| S1 | 上游流未收到权威收束时，系统**不再把它当正常成功** | 下发并落库 `turn_interrupted`；`[DONE]` 仅代表传输结束 |
| S2 | 零交付回合**不扣费** | 阳性：释放 hold、`turn_settled{released:true}`、`credits` 键不出现 |
| S3 | 界面**不再说谎** | 未配对工具卡渲染 `interrupted`（非 ✓ 0ms），提示说明"未收到完成确认 · 未扣费" |
| S4 | 中断态在**刷新/重连后仍在**，且**可被后续续传结果撤销** | 落库事件经 `executionEvents` 重放还原；后续 `tool_result` 能翻回 `done` |
| S5 | 运维能回答"派出去的那个去哪了" | Nest `AgentEvent` 账本有 `turn_interrupted`；pi-runtime outcome 埋点闭环正常 4 态 |
| S6 | 不误伤正常长回合 / 挂起回合 | 阴性样本（会话 B、长回合前缀、waiting 挂起）全部保持既有行为 |

**非目标**：本次不实现子任务持久化单据、跨进程恢复、`pi-durable` upmerge（D2–D7 排期，见 §9）。

---

## 2. 分类与范围

**Architectural**：跨 `packages/agent`、`apps/server`、`apps/web`、`services/pi-runtime` 四个包，新增 SSE 终态事件契约、变更计费语义、扩展时间线状态机。不是"一行 if 修补"。

**本次实施范围 = D1（P0 止血）**，零新增架构组件、零数据库 schema 变更、零上游 vendor 改动。D2–D7 只排期不出刀。

**触发生产发布的刀按项目纪律停在合并前等单独授权**：本规格与实施均不合并、不部署、不改生产数据。

---

## 3. 根因（引用，不重复论证）

诊断已坐实：`spawn-subagent.ts:66 await attempt.promise` 把父回合绑在同进程内存子 lane 上；`08:46:14.604Z` tool_call → `08:46:15Z` pi-runtime pod 被滚动更新替换 → 父子 run 与 promise 一起蒸发 → Nest 侧上游 SSE 迭代器自然耗尽、`sawTerminalEvent=false` → 结算块把它当正常收尾（`Math.max(1, ceil(quote.credits))` 扣 1 分）→ controller 机械补 `[DONE]` → 前端 `finalizeTurnTimeline` 把未配对 `running` 工具无条件翻 `done` → 界面显示 ✓。

三条排除项已证：非工具超时（5min，实际 18s）、非并发/参数失败（那些都同步 return `tool_result`）、非客户端断连（该路径不落 `turn_settled`）。

**根上的一句话**：行业把「完成」建模为独立于连接的持久化状态转换；本项目把它绑在内存 promise 上，并让 SSE 断流越权做了终止判定。

---

## 4. 方案对比与裁决

| 方案 | 做法 | 取舍 | 裁决 |
|---|---|---|---|
| **A. 只在前端改 `finalizeTurnTimeline`** | 用 `opts.truncated` 把未配对工具渲染成中断 | 服务端仍扣费、刷新后无据、判据散在前端；`truncated` 有 82 条历史噪声，一律标中断会误伤 | ❌ 否决：界面不撒谎但账单继续撒谎 |
| **B. 单一终态判据 + 落库事件一等化（推荐）** | 新增 `classifyTurnEnd()`；合成 `turn_interrupted` 走 `pushTraceEvent` 落库并下发；计费/前端/账本从同一判据派生；复用 #840 `AgentEvent` 与 #843 快照重放 | 改动跨 4 包但每处都是窄改；不新增 seq、不新增表、不动收口函数签名 | ✅ **采纳** |
| **C. 直接上 `pi-durable` / 一等子任务单据** | `ownership:{kind:"task"}` + `replay:"safe"` + reporter task follow-up | 真正治本，但 0.99.2 是 harness 最后一代，`pi-durable` Experimental；应与阶段 C upmerge 合并排期 | ⏸ 归 D7 预研，本次不做 |

**B 优于诊断原文的三处修正**（实施必须以本节为准）：

1. **`reason` 用 `no_terminal_event`，不用 `upstream_disconnected`**。Nest 侧唯一可观测事实是"本流没收到 `agent_end`/`error`"；pod 重启 / nginx 掐断 / 客户端断网无法在 Nest 侧确证，把猜测写成原因是二次说谎。文案同样保持中性。
2. **不改 `finalizeTurnTimeline` 签名、不加 `interrupted` 参数**。把 `turn_interrupted` 作为**落库事件**让 `applyTimelineEvent` 先执行，届时工具卡已是 `interrupted` 而非 `running`；`finalizeTurnTimeline` 只处理 `running`，自然不再翻回 ✓。实时 SSE、刷新重放、断连续传三条路径一次覆盖，且天然复用 #840/#843 的事件一等化主线。
3. **补 `observeSubagentOutcome` 不等于闭环**。进程被替换时 `await attempt.promise` 永不 resolve，那行代码根本执行不到；且该 counter 是进程内内存，pod 重启归零，`spawned − Σoutcome` 跨重启恒 0。⇒ D1 的运维可见性由 **Nest `AgentEvent` 账本**承担；pi-runtime 埋点只修"正常 4 态死代码"，两者分工不得互相冒充。此为 D2 子任务单据的必要性证据。

---

## 5. 设计

### 5.1 单一终止判据 `classifyTurnEnd()`

新增纯函数模块 `apps/server/src/agent/turn-end.ts`（无副作用、可单测、被四处 import）：

```ts
export interface TurnEndSignals {
  /** 本流见到权威收束（agent_end / error） */
  sawTerminalEvent: boolean
  /** 权威收束为 error */
  runFailed: boolean
  /** 流耗尽时仍挂在 waiting_user{waiting}（正常挂起，run 仍活） */
  sawWaitingUser: boolean
  /** while 循环自然退出（非消费方 generator.return）；记录适配器恒 true，见下 */
  loopCompletedNaturally: boolean
  /** 本流是 owner（shadow 流不参与终止判定与结算） */
  isOwner: boolean
  /** prompt 被 pi 接受。false ⇒ pi 侧整轮不存在，不得发中断事件 / 造记录 */
  promptAccepted: boolean
  /** executionEvents 中存在 turn_usage */
  hasTurnUsage: boolean
  /** 存在 tool_call 无配对 tool_result */
  hasOutstandingToolCall: boolean
}

export type TurnEndKind =
  | 'completed' | 'failed' | 'suspended' | 'detached' | 'shadow' | 'not_started' | 'interrupted'

export function classifyTurnEnd(s: TurnEndSignals): TurnEndKind
export function shouldEmitInterrupted(k: TurnEndKind): boolean   // 仅 interrupted
export function shouldReleaseHold(s: TurnEndSignals, k: TurnEndKind): boolean
```

判定顺序（**唯一真相源**，短路不可调换）：

```
!isOwner                        → 'shadow'        （409 并入流，无自己的 run）
!promptAccepted                 → 'not_started'   （pi 侧整轮不存在，不得造记录）
!loopCompletedNaturally         → 'detached'      （客户端断连；结算块本就不可达，finally 全退）
sawTerminalEvent                → runFailed ? 'failed' : 'completed'
sawWaitingUser                  → 'suspended'     （既有 turn_suspended 路径，行为不变）
否则                             → 'interrupted'
```

⚠️ `!loopCompletedNaturally` 必须排在 `sawTerminalEvent` **之前**：断连可能发生在已见 `agent_end` 之后，若先判 `sawTerminalEvent` 会把 detached 误判成 completed。此分支只在运行时可达。

⭐ **`not_started` 是实施期由既有回归锁 `turn-settle-detached.test.ts`「prompt 未被接受 ⇒ 不造假记录」实锤补上的**：prompt 被上游拒绝时流同样自然耗尽，若此时合成 `turn_interrupted` 并 `pushTraceEvent`，`executionEvents` 非空 ⇒ `hasContent=true` ⇒ `finalizeTurn` 造出一条本不存在的 assistant 行。故 `promptAccepted=false` 必须**优先于** `detached` 短路，且不产生任何落库帧。`deriveSignalsFromRecord` 中该值恒 `true`（已落库即证明 prompt 曾被接受）。

`shouldReleaseHold` 是**更窄的动作判据**，仅当：

```
kind === 'interrupted'
&& !hasTurnUsage                 // 零可归因 usage
&& hasOutstandingToolCall        // 真的有结果没回来
&& !runFailed                    // error 分支已单独 release
&& isOwner                       // shadow 流无 hold
```

**为什么下发判据宽、计费判据窄**：全库 `metadata.truncated` 有 82 条，混着"Nest 侧提前收尾、pi 侧继续跑完并经 followUp tail 续传"的正常长回合。若按 `!sawTerminalEvent` 一律 release，会误伤这些回合（少收费）并把正常长回合永久钉成失败。窄判据精确对应"未交付不收费"：会话 A 零 usage + 未配对 spawn ⇒ 命中；会话 B 有 usage + 配对结果 ⇒ 不命中；长回合前缀有 usage/结果 ⇒ 不命中。

**双信号源适配器**（判据同源、驱动不循环）：

| 适配器 | 输入 | 用途 |
|---|---|---|
| `deriveSignalsFromStream(...)` | 运行时变量 `sawTerminalEvent / runFailed / sawWaitingUser / loopCompletedNaturally / turnRole / promptAccepted` + `executionEvents` | 驱动 SSE 下发与计费 |
| `deriveSignalsFromRecord(events, metadata)` | 落库 `executionEvents` + `AgentMessageMetadata` | 贴生产记录求值、静态守卫、故障注入判据 |

⚠️ `deriveSignalsFromRecord` 中 `sawTerminalEvent = metadata.truncated !== true`（`truncated` 正是 `!sawTerminalEvent` 的落库投影），`loopCompletedNaturally` / `isOwner` 恒为 `true`（能落库成 assistant 消息的 owner 回合即自然收尾；断连兜底走 `void finalizeTurn` fire-and-forget，不进入本判据的求值域）。**落库投影只用于求值/守卫，不得反向驱动运行时决策**——避免用自己写下的结论判定自己。`waiting_user` 从事件序列末态取（有 resolved 则非挂起）；`hasOutstandingToolCall` 由 `tool_call` / `tool_result` 的 `toolCallId` 差集计算，`hasTurnUsage` 由是否存在 `turn_usage` 事件判定。

### 5.2 服务端事件契约

| 项 | 定义 |
|---|---|
| 事件 | `turn_interrupted` |
| 产出点 | `agent.service.ts` 循环出口，与 `turn_suspended`（`:3759`）**互斥分支** |
| `data` | `{ reason: 'no_terminal_event', runId?: string, lastSeq?: number, outstandingToolCallIds?: string[] }` |
| 落库 | **`pushTraceEvent('turn_interrupted', data)`**（合成事件不走主循环那条 `if`，必须显式落库；`TRACE_PERSIST_EVENT_TYPES` 在 0.99.2 是**死代码、全仓零引用**，加它无效） |
| 账本 | `pushTraceEvent` 内 `appendAgentEvent(ev)` 自动进 #840 `AgentEvent` 表 ⇒ 刷新/续传/运维取证同源 |
| 下发 | `yield { type:'turn_interrupted', data } as unknown as AgentStreamEvent`；`packages/agent/src/types.ts` union 登记该 type |
| `[DONE]` | controller 行为不变，但语义由规格固定：**只代表传输结束，不代表业务成功** |

`lastSeq` 取 `currentPiEvent?.seq`（会话 A = 152），作为"最后一条 pi 事件"锚点，供运维对账。`outstandingToolCallIds` 由 `executionEvents` 里 `tool_call` / `tool_result` 的 `toolCallId` 差集得到。

### 5.3 计费

`agent.service.ts` 结算块（`:3893` 起）在 `usage` 计算后、`if (runFailed)` 之前插入独立分支：

```
if (shouldReleaseHold(signals, kind)) {
  await this.points.release(billingHold.id, '回合未收到完成确认，零交付不扣费')
  holdOpen = false
  const d = pushTraceEvent('turn_settled', { holdId, released: true }).data
  emitSettled(d); yield { type:'turn_settled', data:d }
} else if (runFailed) { ...既有... } else { ...既有... }
```

**不动** `Math.max(1, Math.ceil(quote.credits))`：它服务于"有 usage 但 quote 归零"的正常回合，改动会扩大回归面。本刀让它对零交付回合**根本不可达**。

`finally` 的 `holdOpen` 兜底（`:4189`）保持不变，作为 release 失败时的二次保险。

### 5.4 前端呈现（可恢复中断态）

| 文件 | 改动 |
|---|---|
| `turnTimeline.ts` | `TimelinePart.tool.status` 增 `'interrupted'`；`TimelineEvent` union 增 `turn_interrupted`；`applyTimelineEvent` 增 case |
| `applyTimelineEvent` case | 把所有 `status==='running'` 的 tool 翻 `'interrupted'`；push 一条 `notice{ id:'notice:turn-interrupted', tone:'error', text, retryLabel }`，用稳定 id 保证幂等（重放/重复下发不叠加） |
| **可恢复** | `tool_result` 按 `toolCallId` 命中时现有分支已无条件翻 `done`/`failed`，天然支持从 `interrupted` 恢复；⚠️ **无 `toolCallId` 的回退匹配当前只找 `status==='running'`**（`turnTimeline.ts:552-557`）⇒ 必须把匹配扩到 `interrupted`，否则续传结果会被当孤儿降级、界面二次说谎。`turn_end`/`done` 收口时若未配对工具已全部配对，移除 `notice:turn-interrupted` |
| `finalizeTurnTimeline` | **不改**（见 §4 修正 2） |
| `AgentTurnTimeline.vue` | tool 分支增 `v-else-if="part.status==='interrupted'"`（⏹ + 「未收到结果」）；notice 带 `retryLabel` 时渲染重试按钮 |
| `AgentSideRail.vue` | `handleEvent` switch 增 `case 'turn_interrupted'` → `agent.feedTimeline(...)`；**不**追加「⚠️ 连接意外断开」文案（与 `turn_suspended` 同款豁免），避免双重报错 |
| `executionTraceReducer.ts` | `ExecutionStepStatus` 增 `interrupted`，`statusIcon` / `stepDuration` 对齐；`finalizeExecutionTrace` 不把 `interrupted` 翻回 done |

**文案（中性、不臆断原因）**：`本轮未收到完成确认，结果可能未交付；本次未扣费`；带未配对子代理时追加 `子代理调研没有返回结果`。禁止写「服务更新打断了这次调研」这类无证据归因。

**重试**：复用既有 `sendMessage(message, ..., isRetry=true)` 续跑语义（`AgentSideRail.vue:1661/1726`：不重复落 user 消息）。新增 `AgentTurnTimeline.vue` 的 `emit('retryTurn')`，SideRail 在挂载点接 `@retry-turn`。**不新造消息链路**。

### 5.5 指标与账本分工

| 层 | 动作 | 覆盖 |
|---|---|---|
| pi-runtime `spawn-subagent.ts:66` | `metrics.observeSubagentOutcome(outcome.status)` | 正常 4 态（completed/failed/timeout/budget_exceeded）；**覆盖不到进程蒸发** |
| Nest `AgentEvent` | `turn_interrupted` 落库 | **跨进程持久**，本次事故的运维证据 |
| 告警（P4，本刀只留判据） | `∑outcome` 与 `spawned` 的差值**仅在单进程生命周期内**有意义；跨重启必须为 0，不得据此告警 | 明确边界，不自欺 |

### 5.6 数据流

```
pi SSE 自然耗尽（无 agent_end/error）
  → deriveSignalsFromStream → classifyTurnEnd = 'interrupted'
  → pushTraceEvent('turn_interrupted')  ─┬─→ executionEvents / AgentEvent 账本（刷新可重放）
                                        └─→ SSE yield ─→ 前端 applyTimelineEvent
                                                          ├─ running tool → interrupted
                                                          └─ notice（未扣费 + 重试）
  → shouldReleaseHold（窄判据）→ release hold → turn_settled{released:true}
  → controller 补 [DONE]（仅传输结束）
  → finishStreaming → finalizeTurnTimeline 只看 running ⇒ 不翻回 ✓
```

---

## 6. 判据求值：贴真实生产记录 + 变异自检

遵循项目纪律「按数据形态分支的修复，判据必须先贴真实生产记录求值 + 变异自检」。夹具来自生产 SQLite 只读快照（会话 A/B 的 `metadata.executionEvents`，已脱敏为 type/seq/gSeq/关键 data）：

**阳性 A**（`cmwbvfp4p000qrk01pch77w13`）：
```
truncated: true
events: thinking, text, thinking(done),
        tool_call{spawn_subagent, call_334ae8…, gSeq 152},
        turn_settled{credits:1, tokens:{in:0,cache:0,out:0}}
```
⇒ `interrupted` / `shouldEmitInterrupted=true` / `shouldReleaseHold=true`

**阴性 B**（`…42ap2hej`）：
```
truncated: (键不出现)
events: …, tool_call{spawn_subagent}, tool_result{同 id},
        turn_usage{9459/2820, estimatedCredits:12},
        turn_settled{credits:12, tokens:{9459/104704/2820}}
```
⇒ `completed` / 两个动作均 `false`

| 变异 | 期望 | 目的 |
|---|---|---|
| A 的 `truncated` 改 `false` | `completed`，两动作 false | 证明判据真依赖数据形态，非恒真 |
| A 补一条配对 `tool_result` | `shouldReleaseHold=false` | 证明窄判据不是自匹配恒绿 |
| A 补一条 `turn_usage` | `shouldReleaseHold=false` | 同上（零 usage 条件生效） |
| B 删 `turn_usage`、删 `tool_result`、`truncated=true` | 转 `interrupted` 且 release | 证明非恒假 |
| 独立挂起样本 C：`truncated=true` + `waiting_user{waiting}` 且无 resolved | `suspended`，两动作 false | 证明挂起互斥（⚠️ 不能由 B 直接加 waiting 构造：B 的 `truncated` 键不出现 ⇒ 判定顺序先短路到 `completed`） |
| 独立断连样本 D：`sawTerminalEvent=true` + `loopCompletedNaturally=false` | `detached`（非 `completed`） | 锁住判定顺序不可调换 |

⚠️ 变异必须能 RED；若「删掉判据条件后测试仍全绿」判为伪变异，先修判据再继续（#815 教训）。BSD grep 不支持 BRE `\|`，取证命令一律 `grep -E`。

---

## 7. 错误处理与兼容性

- **fail-soft**：`pushTraceEvent` / `appendAgentEvent` / `points.release` 各自已有 try/catch 或 fire-and-forget；新增分支不得让计费异常打断对话。
- **幂等**：`turn_interrupted` 用稳定 notice id；同一 run 只下发一次（循环出口天然唯一）；重放与实时重复到达不叠加。
- **老消息兼容**：82 条历史 `truncated` 消息**不回填、不改判**（项目偏好：历史时点结论只做只追加状态回填）。它们继续走既有提示语；新回合才有 `turn_interrupted` 事件。
- **shadow 流 / 断连**：`turnRole!=='owner'` 或 `!loopCompletedNaturally` 不落中断事件（结算块本来就不可达）。
- **挂起**：`suspended` 保持现有 `turn_suspended` 与既有结算行为，本刀不动。
- **`[DONE]` 语义**：不改传输，只由规格固定"非业务成功"，前端不得再单凭 `[DONE]` 判完成。
- **outcome 埋点**：`observeSubagentOutcome` 参数类型与 `SubagentOutcome.status` 4 值逐值一致，无需映射；`attempt.promise` 契约上永不 reject。

---

## 8. 测试策略（TDD，先 RED 后 GREEN）

| 层 | 文件 | 断言 |
|---|---|---|
| 判据纯函数 | `apps/server/src/agent/turn-end.test.ts`（新） | §6 全部行：A/B 求值 + 5 组变异；挂起/断连/shadow 三态 |
| 服务端集成 | `apps/server/src/agent/agent.service.turn-interrupted.test.ts`（新） | 仿 `turn-identity.test.ts:305` 用 `onClosed()` 构造流自然耗尽：恰一个 `turn_interrupted`、`lastSeq` 正确、落库 executionEvents 含该事件；正常 `agent_end` 阴性不发；waiting 挂起阴性不发；零交付 `turn_settled{released:true}` 且 `points.settleFromHold` 零调用 |
| 前端时间线 | `apps/web/src/components/agent/turnTimeline.interrupted.test.ts`（新） | `turn_interrupted` 把 running→interrupted；`finalizeTurnTimeline` 不翻回；`replayTimelineEvents` 重放还原；后续 `tool_result` 可恢复（可恢复性回归锁） |
| 前端接线 | `AgentSideRail.turnSuspended.test.ts` 同族新增用例 | `case 'turn_interrupted'` 存在且喂入 timeline；不追加断链文案 |
| pi-runtime 埋点 | `services/pi-runtime/src/tools/spawn-subagent.test.ts` 增用例 | 4 态各有 outcome；rejected 分支不产生 outcome |
| 静态守卫 | 服务端测试内 | 每个 `tool_call` 必有配对 `tool_result` 或显式 `turn_interrupted`；零 usage 不得 `settle credits>0` |

命令（nvm node24、项目纪律）：
```
$HOME/.nvm/versions/node/v24.13.0/bin/... pnpm --filter @lnkpi/server exec vitest run <files> --maxWorkers=1 --no-file-parallelism
$HOME/.nvm/versions/node/v24.13.0/bin/... pnpm --filter @lnkpi/web exec vitest run <files> --maxWorkers=1 --no-file-parallelism
pnpm --filter @pi-lnk/pi-runtime test      # node --import tsx --test
vue-tsc -b（勿加 --noEmit，composite 会 TS6310）
```
本机 pnpm 须 `env -u NODE_OPTIONS`；断言禁 `as never`。

---

## 9. 分刀与依赖（本次只做 D1）

| 刀 | 内容 | 依赖 | 触发发布 |
|---|---|---|---|
| **D1** | 本规格全部（P0 止血） | 无 | ✅ Nest + Web + pi-runtime（**停在合并前**） |
| D2 | 一等子任务单据 + `requestId` 幂等 | D1 | ✅ |
| D3 | `onUpdate` checkpoint（`tool_update`/`pendingToolOutput`）+ `lane.followUp()/steer()` 持久化 inbox 回注 | D2 | ✅ |
| D4 | 有界显式孤儿恢复 + 幂等重放（**禁止自动 `lane.resume()`**） | D3 | ✅ |
| D5 | pi-runtime `preStop` + `terminationGracePeriodSeconds ≥ 300s` + 发布互斥查在途 | D2 | ✅ 部署配置 |
| D6 | 前端重连重放（`id:` / `Last-Event-ID`） | #843 → #842 P1b | ✅ Web |
| D7 | `pi-durable` upmerge 预研（spec only，并入阶段 C） | D4 | ❌ docs-only |

---

## 10. 明确不做（No-Go）

- ❌ **只加指标当修复**：`observeSubagentOutcome` 补上不改变「完成绑在内存 promise」这一事实，且覆盖不到进程蒸发。
- ❌ **自动 `lane.resume()` 续上游 LLM**：`cmv3zzid` 事故 612s 阻塞，`docs/superpowers/specs/2026-10-21-turn-continuity-design.md:128-130` 已立规。
- ❌ **新建第三套 seq / 状态机**：复用 #840 `AgentEvent` + #843 快照重放 envelope。
- ❌ **用 `opts.truncated` 一律标中断**：82 条历史混着正常长回合，会误伤。
- ❌ **靠加 prompt 规则解决**：L6 余量紧张，点名应走 `promptGuidelines` 动态块（#841 F1/P3）。
- ❌ **把 `reason` 写成 `upstream_disconnected` 等无证据归因**。
- ❌ **改 `Math.max(1, …)` / 改 `finalizeTurnTimeline` 签名 / 改 controller `[DONE]` 补发**。
- ❌ **fork vendor / 提前换 1.x**：`pi-durable` Experimental，只做预研。
- ❌ **回填或改判历史 82 条 truncated 消息**。
- ❌ **本次合并、部署、改生产数据**。

---

## 11. 风险与未闭环项

1. **Nest 侧精确镜像 tag**：会话 A 发生于 `edd2b2cb` 部署（09:14:54Z）之前；机制结论在 #640 基线已成立且逐行同构，逐行定责需补当时 tag。
2. **82 条 truncated 未分层归因**：本刀不触碰历史，D1 基线指标不能直接宣称故障率。
3. **上游流关闭原因不可区分**：`iteratePiEvents` 的 `onClosed` / `onError` 都只置 `closed=true`，Nest 侧无法区分"上游真死"与"Nest 提前收尾、pi 侧仍活"。本刀因此采用**中性文案 + 可恢复中断态 + 窄计费判据**，不宣称已能精确归因；精确区分属 D2/D3 的子任务状态机。
4. **SSE `id:` / `Last-Event-ID` 上线状态未验证**（#843 为 P1b 换读刀）；真机走查本环境不可代跑，**不宣告验收完成**。
5. **CI 与合并**：本刀触发发布；按用户纪律 CI 全绿后停在合并前等单独授权，生产复测另授权。

---

## 12. 实施期补记（只追加状态回填）

规格 §5.4 只写了 `executionTraceReducer.ts`「扩枚举 / 不翻回 / 渲染对齐」，实施期发现**缺一个生产者**：若没有代码把 trace 步置成 `interrupted`，`finalizeExecutionTrace` 的「不翻回」就是空判据，flag 关闭时的回落视图仍会显示「✓ 用时 0ms」——正是 S3 要消灭的二次说谎。故实际落地比 §5.4 多两点，且不改变任何判据：

1. `executionTraceReducer.ts` 增 `applyTurnInterrupted(trace)`（只把 `running` 的 **tool** 步翻 `interrupted`；**不写 `endedAt`/`ms`**，因为中断没有「完成耗时」），并在 `replayExecutionTraceEvents` 增 `turn_interrupted` case，且该 case 必须早于函数末尾的 `finalizeExecutionTrace`。
2. `stores/agent.ts` 的 `feedTimeline`（原本是 store 内部函数、未导出）被导出，并作为**单一漏斗**在实时路径同步调用 `applyTurnInterrupted`；刷新重放由上面第 1 点的 case 承担。实时 / 重放两路与 timeline 一一对应，仍是同一份 `turn_interrupted` 落库事件驱动，没有第二套判据。

配套防假绿：T4 测试追加行为级断言（store 真调用、幂等、重放变异对照），因为纯源码正则无法发现「方法根本没导出」这类运行时断裂。另两处计划假设纠偏（`Metrics.render` 签名、runner-reject 用例）见 plan 的「实施期纠偏」。

3. **§5.1 双适配器的 `sawWaitingUser` 来源必须各自显式给出，禁止共用一个 events 派生函数后 spread。**
实施期 `signalsFromEvents()` 曾返回 `sawWaitingUser` 并被 spread 在显式字段之后，把 `deriveSignalsFromStream` 的运行时变量（权威）覆盖成落库事件末态重算值——直接违反 §5.1「落库投影不得反向驱动运行时决策」。编译器 `TS2783` 报错，但当时 T1 两个 stream 用例都传 `false`，零测试拦截。危害实质：`agent.service.ts:3770` 下发 `turn_suspended` 后不 break，仍走到本判据；若该回合 `executionEvents` 未含 `waiting_user`，挂起会被误判 `interrupted` ⇒ 误发中断事件 + 误退费。故 `signalsFromEvents` 收敛为只返回 `hasTurnUsage` / `hasOutstandingToolCall`；`sawWaitingUser` 由 stream（运行时变量）与 record（`waitingStillPending(events)` 末态）分别显式赋值。这是对 §5.1 的**实现约束补强**，判定顺序与动作判据均未改变。

5. **§5.4 漏了第四个呈现面：公开分享页。** `vue-tsc -b` 在 T6 类型检查暴露 `ShareTurnPart.tool.status` 是独立 union，`toShareTurn.ts` 直接透传 `p.status` 后 `interrupted` 无处可去；更实质的是 `renderPart` 会把 `interrupted` 渲染成**空状态**（等价于「没问题」），而 `ms:0` 又会复刻「✓ 用时 0ms」同类谎言。故 `packages/shared/src/shareTemplate.ts` 扩 union + 状态徽标「未收到结果」+ tool 分支显式 `⏹ 未收到结果` 且禁用耗时；并以 3 条回归锁钉住（分享页诚实 / done 正常态不被吞 / 映射器原样透传）。**S1「所有呈现面都不说谎」必须包含离线公开页**，本点是对 §5.4 的补充而非判据变更：`turn_interrupted` 仍是唯一落库事件，分享页只读既有时线快照。

6. **§5.2 / §5.3 的「落库」必须区分两个数组（master 41490feb 的 P1c 写面分流引入）。**
`executionEvents` 在真 master 上已从「全量事件数组」变为「最小兼容集」：带 `gSeq` 的 `tool_call` / `tool_result` / `turn_usage` 只进 `AgentEvent` 账本（fire-and-forget fail-open），`metadata.executionEvents` 只留 `waiting_user` / `turn_settled` / 无 gSeq 合成事件。三路合并后在合并树实测，D1 若继续读该数组会同时坏三处：未配对工具差集为空、权威终态帧不落 metadata（刷新后复现「✓ 用时 0ms」）、零交付仍扣费。故本规格的架构约束补强为：
- **完成判定与持久化裁剪解耦**：`pushTraceEvent` 漏斗内维护 `turnFactEvents`（全量事实视图，只内存、不落库），`classifyTurnEnd` 的信号与 `outstandingToolCallIds` 一律从它求值；不得读 `executionEvents`，也不得反向依赖账本读回。这是 §5.1「落库投影不得反向驱动运行时决策」在写面分流形态下的具体落地。
- **权威终态帧进保留集**：`turn_interrupted` 与 `turn_settled` 并列无条件留在 `metadata.executionEvents`。二者同理由——前端刷新 / 断连重放直接消费，不能依赖 fail-open 账本（读时 enrichment 还额外要求 `eventsShrunk=true` 且 `runId` 非空）。
- 不把全量写回 metadata，P1c 的清债目标不变（合并树 `agent.service.p1cShrink.test.ts` 保持全绿）。
判据本身（`classifyTurnEnd` 顺序、动作判据）零变更；这是**同源判据的输入契约**补强，不是第二套判据。
