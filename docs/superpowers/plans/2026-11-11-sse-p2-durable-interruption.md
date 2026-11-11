# SSE 事件一等化 P2——待确认门 durable 化（实施计划）

> 母计划：`2026-11-11-sse-session-resume-p0-p2.md` §3（P1c-1..6 / W1c-1..3）；规格预告：`2026-11-11-sse-p1c-ledger-projection-metadata-shrink.md` §5（PR #844）。
> 上游刀：#837（帧契约）/ #840（AgentEvent 账本）/ #843（snapshot 收敛）/ #845（P1c 账本投影，master `41490feb`）。
> 基线：master `41490feb52b3597a8ca41a05f7e76f3f6831af3c` 干净快照逐文件核对，非本地落后工作树。

## 0. 目标

把「挂起确认门」从**进程内内存**（`PendingToolRegistry` 的 entries + 墓碑 10min、`adjudicateLateAnswer` 的 metadata 读时裁决）升级为 **thread state 的一部分**：刷新 / 进程重启 / 换设备后门仍可裁决；超时由持久化 `expiresAt` 驱动；门终态后不再下发活卡片。

## 1. 真值核对（R1–R9，全部回 master 代码核实）

- **R1（state API 预留位）**：`agent.controller.ts:289` `GET threads/:threadId/state`；`agent.service.ts:1715–1734` `getThreadResumeState` 返回 `status/lastGSeq/pendingInterruption`，**类型层 `:1721` 与值层 `:1732` 双层恒 null**。
- **R2（/answers 三分支）**：`agent.service.ts:2207–2240` `answerPiPending` → `client.answer()`；`!data.deduped` 正常 settle 直接返回（**不落任何 durable 终态**）；`deduped+prior` 幂等回执；`deduped 无 prior` → `adjudicateLateAnswer :2268`（真源 = metadata.executionEvents 的 `waiting_user`，CAS 整串 metadata `:2422–2426`；过期是 `Date.now() > ts + timeoutMs` 读时计算 `:2286–2289`）。
- **R3（runtime timer 边界）**：`services/pi-runtime/src/pending-registry.ts:202–205` 用进程内 `setTimeout` 裁决超时；墓碑 `:58–64` 纯内存 10min，重启即丢。母计划 §4 明确「P1/P2 不动 pi-runtime 与 skills」⇒ **本刀不改 runtime**：runtime timer 仍是「让阻塞工具返回 timeout」的必要机制，而**权威状态**改由 Nest 侧 DB 表承载，两路通过 `waiting_user{resolved}` 帧对齐。
- **R4（帧形态）**：`index.ts:49–61` `onWaitStart → dispatchWaitingUser` 下发 `waiting_user{status:'waiting', toolName, callId, timeoutMs, nodeId, ts}`，`onSettled` 下发 `{status:'resolved', reason: answered|timeout|aborted}`；`canvas_command{type:'ask_user', callId, questions}` 由 `tools/ask-user.ts:122` / `propose-plan.ts:85–98` 生成，Nest 在 `agent.service.ts:3751–3773` 落库并 yield。**两条通道仅靠 callId 隐式关联**，正是 `PendingInterruption` 要补的洞。
- **R5（假交互矛盾）**：`propose-plan.ts:85–98` `build()` 恒带 `canvasCommands`（timeout/aborted 分支也 `return build(...)`）→ `pi-events.ts:477–488` 无条件提取 → `agent.service.ts:3751–3773` 只按 callId 去重、无终态门控 → 前端 `turnTimeline.ts:829` 无条件把已终态 question part 翻回 `pending_answer`。
- **R6（调度骨架）**：`automation-scheduler.service.ts:19–50` `AUTOMATION_DEFAULT_JOBS` 三条 seed（`job-generation-notify` 已有 1min 先例）、`:86` `registerHandler`、`:58–63` 注释「进程内唯一 timer 持有者（G1）」⇒ **不新起 timer**，新增一条 seed + handler。`AutomationModule` 非 global，`ProviderModule:14` / `StudioModule:18` 各自 import ⇒ `AgentModule` 需显式 import。
- **R7（schema 样板）**：`schema.prisma:433–456` `AgentEvent`（`@@unique`、`@@index`）；migration 目录 44 个，命名 `YYYYMMDDHHMMSS_snake_case`，`20261111150000_add_agent_event/migration.sql` 为纯 additive 样板；生产 `prisma migrate deploy` 在容器 entrypoint 自动应用（#845 已实证）。
- **R8（DI 兼容）**：`AgentService` 构造函数 `:349–404` 末尾均为 `@Optional()`；既有 20+ 测试按**位置参数** `new AgentService(...)` 构造 ⇒ 新依赖必须**追加为最后一个 @Optional 参数**，缺省时全链路短路（旧行为逐字节不变）。
- **R9（前端现状）**：`apps/web` 全目录对 `/threads/:id/state`、`lastGSeq`、`pendingInterruption` **零匹配**；现有自愈只走 `AgentSideRail.vue:2105 reconcileLatestAssistant()` → `chat/user/messages`。前端 W1c-1/2 需独立接线 + 真机走查，属后续刀。

## 2. 范围（本刀 = 服务端 durable 权威层）

**做**：

1. Prisma `PendingInterruption` 新表 + additive migration（不动存量表/列）。
2. 新 `PendingInterruptionService`：`openGate` / `settleGate`（CAS）/ `getPending` / `isGateLive` / `sweepExpired` + 注册 automation handler。
3. `agent.service.ts` 接线：SSE 派生循环开/关闸、`answerPiPending` 落 durable 终态、`adjudicateLateAnswer` 不复活门、`getThreadResumeState` 返回真实摘要、`getMessages` 抑制终态活卡片。
4. `agent.module.ts` 注册 provider + import `AutomationModule`；`automation-scheduler.service.ts` 追加 1min seed job。
5. 行为级测试 T1–T8 + 变异自检 M1–M6；全量 `src/agent` 快照跑测 + tsc。

**No-Go / 后续刀**（母计划 §4 分期原则：每期独立 PR、独立 CI、独立合并窗口）：

- ❌ 改 `services/pi-runtime/**`（独立 K3s 部署单元，需手工 dispatch `runtime-deploy.yml`；其 timer 与墓碑按 R3 保留）。
- ❌ 前端 `AskUserCard` state 驱动重建 / 终态卡（W1c-1/2）——零消费 state API、需动 `AgentSideRail.vue` 巨文件 + 棘轮闸门 + A-6 真机走查，独立刀。
- ❌ 摘除 `waiting_user`/`turn_settled` 的 metadata 直写（P1c R7 健壮性边界；表接管读端后再立项）。
- ❌ 收回 `PendingToolRegistry` 到上游 `before_tool` block（母计划 §3.2 第 6 条「逐步」，独立刀）。
- ❌ 存量 `waiting_user` 行回填（无源 callId/timeoutMs 全量语义，且老行读路径直通）。

> 因此 **P1c-5「重启存活」以 state API 为判据**（服务端 durable 核心），但「刷新后卡片可点」的端到端验收仍欠前端刀 + A-6 真机，不宣告验收完成。

## 3. 设计

### 3.1 表（additive）

```
model PendingInterruption {
  id            String   @id @default(cuid())
  threadId      String          // 自由字符串：threadId 可能是前端自定义键，不建 FK relation
  runId         String?
  callId        String
  kind          String   @default("ask_user")
  questionsJson String?
  status        String   @default("pending")   // pending | answered | expired | aborted
  answerJson    String?
  expiresAt     DateTime
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@unique([threadId, callId])
  @@index([threadId, status])
  @@index([status, expiresAt])
}
```

### 3.2 生命周期（单权威状态）

| 事件 | 动作 |
|---|---|
| `canvas_command{type:'ask_user', callId, questions}` | `openGate`（补齐 questionsJson/kind；若先于 waiting_user 到达，expiresAt 用默认 5min 兜底，随后被 waiting 帧覆写为 `ts+timeoutMs`） |
| `waiting_user{status:'waiting', callId, timeoutMs, ts}` | `openGate`（`expiresAt = ts + timeoutMs`，覆写兜底值） |
| `waiting_user{status:'resolved', reason}` | `settleGate`（reason → `answered`/`expired`/`aborted`；CAS 只翻 `pending`） |
| `POST /answers` 正常/幂等回执 | `settleGate(callId, decision==='decline' ? 'aborted' : 'answered', answerJson)`；CAS 天然幂等 |
| `deduped 无 prior`（late answer） | `adjudicateLateAnswer` 前置查表：门非 `pending` 或已过 `expiresAt` ⇒ 返回 `expired:true` 终态回执，**不注入、不复活门** |
| 每 1min `job-pending-interruption-sweep` | `updateMany({ where: { status:'pending', expiresAt: { lt: now } }, data: { status:'expired' } })`，幂等（第二次 count=0） |
| `GET threads/:id/state` | `getPending(threadId)` → 仅 `status=pending && expiresAt>now` 的摘要；无则 `null`（旧形状兼容） |
| SSE / 历史重放 `canvas_command{ask_user}` | `isGateLive(callId)` 为 false ⇒ 不下发卡片 / 从响应副本 `executionEvents` 剔除（仅对有门记录的行改写，老行直通） |

**失败纪律**：`openGate` / `settleGate` / 门控查询全部 **fail-open**（try/catch，写失败记 warn 不阻塞 SSE 与 /answers；读失败按「门仍活」保守放行），与 `appendAgentEvent` 对称。

### 3.3 一致性口径

「是否还发卡片」与「门是否可执行」同由 `PendingInterruption.status==='pending' && expiresAt>now` 决定（母计划 §3.2 第 5 条）。`getPendingLiveness`（runtime 探活）保留不动，避免破坏旧会话；P2 新门以表为准。

## 4. 测试判据（全部可失败 + 变异自检 RED→还原）

| # | 用例 | 判据 | 变异自检 |
|---|---|---|---|
| T1 | 门创建即落库（waiting 帧 + ask_user 卡） | 表有 `status=pending`、`expiresAt===ts+timeoutMs`、`questionsJson` 还原、重复帧幂等（不双行） | 去掉 `openGate` → 零行 RED |
| T2 | 正常作答 CAS | `/answers` 后 `status=answered` + `answerJson`；重复请求 `updateMany` 条件命中 0、状态不变、不双翻 | 去掉 `where status:'pending'` → 重复覆盖 RED |
| T3 | 超时扫描 | mock 时钟越过 `expiresAt` → `sweepExpired` 翻 `expired`；二次扫描 count=0 | 去掉扫描 → RED |
| T4 | late answer | `expired` 后作答：返回 `expired:true`，门仍 `expired`，metadata 不复活 | 去掉表判定 → 注入 late-answer / 翻 answered → RED |
| T5 | 重启存活 | 新 `PendingInterruptionService` 实例（共享 store）读 `getPending` 仍返回 pending 摘要；state API 返回非 null | 用进程内 Map 模拟 → RED |
| T6 | 一致性：终态门不下发活卡片 | 门 `answered/expired` 后 SSE 无 `canvas_command{ask_user}`，历史 `getMessages` 响应 `executionEvents` 无 `pending_answer` 形态卡片 | 去掉 `isGateLive` 判据 → RED |
| T7 | 阴性/回归 | 无门记录行直通（旧会话 API 原样）、新 service 缺省（@Optional undefined）时全链路短路、既有 `answers-adjudication`/`eventLedger`/`p1cShrink` 全绿 | — |
| T8 | state API 形状 | 无 pending 行 → `pendingInterruption:null`；有 → 含 `callId/kind/questions/expiresAt` | 恒 null → RED |

回归面：`src/agent` 全量快照跑测（93 文件 1395+ 用例）、`automation` 测试、`vue-tsc`/`tsc` 零新增错误。

## 5. 合并后生产复测清单（**另行授权**）

- 迁移日志含 `Applying migration 20261111210000_add_pending_interruption`；DB 表/索引存在。
- 真实 ask_user 回合 → 表出现 pending 行、`expiresAt` 正确；作答 → 翻 answered；超时 → 扫描翻 expired。
- 重启容器后 state API 仍返回 pending（durable 核心）；旧会话 `getMessages` 不回归。
- ⚠️ A-6 真机刷新重建卡片 / 终态卡仍欠（前端刀 + 真机走查），不宣告验收完成。

## 6. 交付纪律

单 commit squash；REST 推 PR（裸 blob sha + `base_tree` 仅列改动路径 + `compare` 核验 DELTA 与 `ALL_PARALLEL_KEPT`）；CI 三 job 全绿后**停合并前等单独授权**（合并触发 API 生产部署 + additive 迁移）。
