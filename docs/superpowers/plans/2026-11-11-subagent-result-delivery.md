# 子代理结果回传 P0 止血 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"上游 SSE 流自然耗尽但从未收到 `agent_end`/`error`"的回合不再被当成成功——下发并落库 `turn_interrupted`、零交付时释放计费 hold、前端把未配对工具渲染成可恢复的 `interrupted` 态，并补上 pi-runtime 正常 4 态 outcome 埋点。

**Architecture:** 引入纯函数模块 `turn-end.ts` 作为唯一终止判据；运行时在 `streamConversation` 循环出口算出一次 `TurnEndSignals` + `TurnEndKind`，SSE 事件下发、计费分支、落库三处共用这两个变量。前端不新增判据，只消费落库的 `turn_interrupted` 事件（#840 `AgentEvent` 账本 + #843 快照重放主线），靠 `applyTimelineEvent` 把 `running` 工具翻成 `interrupted`，`finalizeTurnTimeline` 只看 `running`，因此无需改收口函数签名。

**Tech Stack:** NestJS + TypeScript（`apps/server`）、Vue 3 + Pinia + vitest（`apps/web`）、node:test + tsx（`services/pi-runtime`）、`@earendil-works/pi-agent-core@0.99.2`、SQLite/Prisma `AgentEvent` 账本。

**Spec:** `docs/superpowers/specs/2026-11-11-subagent-result-delivery-design.md`（执行前必读；本计划从该规格推导，二者同行）

## Global Constraints

- **代码基线 = 真 master `62cd739c`（#843）**。本地主仓 `/Users/4seven/workspace/pi-lnk` 是 `5926ac72` 文档分支（0.85.1、工作树长期脏），**禁止基于它读源码或改刀**。实施目录 = 干净快照 `/tmp/pi-lnk-master-62cd739c`（`gh api repos/{owner}/{repo}/tarball/62cd739c` 解包）。所有代码路径相对该目录。
- **本机 ↔ GitHub 仅 `gh api` 可达**（git push 502 / SSH denied / fetch 不可达）。快照无 `.git`，因此**每个任务末尾的 "Commit" 步骤 = 把本任务改动路径登记进 Task 6 的 REST 单 commit 清单**；Task 6 统一按 `blob → tree(base_tree 只传改动路径) → commit → ref → PR` 推送，推前逐路径裸 blob sha 比对 master，推后 `compare` 核验。
- **本次不合并、不部署、不改生产数据**。D1 触发发布（apps/server + apps/web + services/pi-runtime）；按用户纪律 CI 全绿后停在合并前等单独授权。
- **规格与计划文档落在主仓** `docs/superpowers/specs/` 与 `docs/superpowers/plans/`（用户偏好路径，新增文件不触碰他人改动）；实施时同步复制一份到快照 `docs/` 内以便随 PR 同行。
- vitest 用 nvm node24：`$HOME/.nvm/versions/node/v24.13.0/bin` 加入 PATH，命令带 `--maxWorkers=1 --no-file-parallelism`；本机 pnpm 须 `env -u NODE_OPTIONS`；`vue-tsc -b` **不加** `--noEmit`（composite TS6310）；断言**禁用** `as never`。
- 快照需软链依赖：`ln -s /Users/4seven/workspace/pi-lnk/node_modules /tmp/pi-lnk-master-62cd739c/node_modules`，并对 `apps/server`、`apps/web`、`services/pi-runtime` 各自 `node_modules` 同法软链（版本基线以主仓已装 vitest/tsx 为准；新文件不依赖 `@lnkpi/shared` 运行时，见 Task 1）。
- **判据纪律**：按数据形态分支的修复，判据必须先贴真实生产记录求值 + 变异自检（#815 教训）；「0 命中」须排除假 0——BSD grep 不支持 BRE `\|`，一律 `grep -E` 或单模式。
- **文案纪律**：`reason` 恒为 `no_terminal_event`；禁止 `upstream_disconnected` 等无证据归因；禁止「服务更新打断了这次调研」。
- **键不出现纪律**：`released: true` 的 `turn_settled` 不带 `credits` / `tokens` / `model` 键；完整回合不写 `truncated` 键。
- **No-Go**：不改 `Math.max(1, Math.ceil(quote.credits))`、不改 `finalizeTurnTimeline` 签名、不改 controller `[DONE]` 补发、不回填历史 82 条 `truncated` 消息、不自动 `lane.resume()`、不新建第三套 seq/状态机、不 fork vendor、不靠加 prompt 条文。

## Review Focus

以下五类输入规格未显式展开、最可能咬人，各自已在所属任务的测试中钉住：

1. **断连发生在 `agent_end` 之后** —— 合理期望是判为 `detached` 而非 `completed`（规格 §5.1 判定顺序短路）。→ Task 1 独立样本 D + 变异「把 `!loopCompletedNaturally` 挪到 `sawTerminalEvent` 之后」必须 RED。
2. **零 usage、无任何 `tool_call` 的纯文本断流回合** —— `hasOutstandingToolCall=false` ⇒ `shouldReleaseHold=false`，仍走既有 `Math.max(1,…)` 结算。这是**范围边界不是 bug**（窄判据刻意不误伤长回合），但必须被明确固定，不能悄悄改。→ Task 1 `it('纯文本断流：不释放 hold（范围边界）')`。
3. **无 `toolCallId` 的老数据/续传 `tool_result`** —— 合理期望是能把 `interrupted` 工具翻回 `done`，而不是被当成孤儿降级。→ Task 3 `it('可恢复：无 callId 的 tool_result 命中 interrupted 工具')`。
4. **`turn_interrupted` 重复到达 / 刷新重放** —— 合理期望是 notice 只出现一次、工具状态不倒退。→ Task 3 `it('幂等：重放两次只产生一条 notice')`。
5. **挂起回合被误发中断 / 重复叠加断链文案** —— 合理期望是 `waiting_user{waiting}` 仍走 `turn_suspended`，前端不追加「⚠️ 连接意外断开」。→ Task 4 `it('turn_interrupted 与 turn_suspended 互斥且不追加断链文案')`。

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `apps/server/src/agent/turn-end.ts` **（新建）** | 唯一终止判据：`classifyTurnEnd` / `shouldReleaseHold` / `shouldEmitInterrupted` / 两个信号适配器 / 未配对工具差集 | T1 |
| `apps/server/src/agent/turn-end.test.ts` **（新建）** | 贴生产记录 A/B 求值 + 6 组变异自检 + 静态守卫 | T1 |
| `packages/agent/src/types.ts` | `AgentStreamEvent.type` union 登记 `turn_interrupted` | T2 |
| `apps/server/src/agent/agent.service.ts` | 循环出口产出/落库事件；结算块插入 release 分支；共用同一 `turnEndSignals`/`turnEndKind` | T2 |
| `apps/server/src/agent/agent.service.turn-interrupted.test.ts` **（新建）** | 服务端集成：阳性/阴性/挂起/断连 + 计费断言 | T2 |
| `apps/web/src/components/agent/turnTimeline.ts` | `TimelinePart` / `TimelineEvent` 扩 `interrupted`；`applyTimelineEvent` 新 case + 可恢复 + 幂等 | T3 |
| `apps/web/src/components/agent/turnTimeline.interrupted.test.ts` **（新建）** | 时间线状态机测试 | T3 |
| `apps/web/src/components/agent/executionTraceReducer.ts` | `ExecutionStepStatus` 扩 `interrupted`；`finalizeExecutionTrace` 不翻回 | T4 |
| `apps/web/src/components/agent/AgentExecutionTrace.vue` | `statusIcon` / `stepDuration` 对齐 | T4 |
| `apps/web/src/components/agent/AgentTurnTimeline.vue` | tool 卡片 `interrupted` 渲染；notice 重试按钮 + `emit('retryTurn')` | T4 |
| `apps/web/src/components/agent/AgentSideRail.vue` | `handleEvent` 新 case → `agent.feedTimeline`；挂载点接 `@retry-turn`；断链文案豁免 | T4 |
| `apps/web/src/stores/agent.ts` **（实施期补，见下方纠偏①）** | 导出 `feedTimeline`；在同一漏斗同步 `executionTrace` 回落视图 | T4 |
| `apps/web/src/components/agent/AgentSideRail.turnInterrupted.test.ts` **（新建）** | 接线与文案互斥测试 + 行为级防假绿锁（共 9 条） | T4 |
| `services/pi-runtime/src/tools/spawn-subagent.ts` | `outcome` 后补 `metrics.observeSubagentOutcome(outcome.status)` | T5 |
| `services/pi-runtime/src/tools/spawn-subagent.test.ts` | 4 态 outcome + rejected 分支无 outcome | T5 |
| `packages/shared/src/shareTemplate.ts` **（T6 类型检查补，见纠偏④）** | `ShareTurnPart.tool.status` 扩 `interrupted`；`renderPart` 与 `STATUS_LABEL` 不伪造 ✓/耗时 | T6 |
| `packages/shared/src/shareTemplate.fidelity.test.ts` | 分享页 D1 双回归锁（interrupted 诚实 / done 不被吞） | T6 |
| `apps/web/src/lib/share/toShareTurn.test.ts` | 映射器 `interrupted` 原样透传锁 | T6 |
| `docs/superpowers/{specs,plans}/2026-11-11-subagent-result-delivery*.md` | 规格与计划随 PR 同行 | T6 |

**分解依据**：T1 是无依赖纯函数，可独立 RED→GREEN；T2 消费 T1 的导出（接口在 T1 的 Interfaces 块锁定）；T3 是前端模型层，与 T2 只通过 SSE 事件名耦合；T4 消费 T3 的状态字面量；T5 完全独立（pi-runtime 单行埋点）。每个任务都有自己的测试周期，可单独被 reviewer 拒绝而不拖累邻居。

### 实施期纠偏（只追加状态回填，不改写原步骤）

> 以下三处是**写计划时基于静态阅读作出的错误假设**，在实施期由真代码 / 真签名证伪并修正。原步骤保留作为决策留痕，以本节为准。

**① `agent.feedTimeline` 原本不可调用（最危险的一处）。**
`stores/agent.ts:467` 的 `feedTimeline` 是 setup store 的**内部函数**，`return {…}` 里没有导出；计划 T4 Step 3(a) 直接写 `agent.feedTimeline(event)` 会在运行时报 `not a function`。更糟的是 T4 原测试是**源码级正则**，只验「写了这串字符」，即使方法不存在也会全绿 ⇒ 典型「判据自匹配恒绿」假绿。
修正：
- `stores/agent.ts` 的 return 增加 `feedTimeline`（typed `TimelineEvent` 闭集入参，无附加副作用，暴露漏斗合理）；
- 同一漏斗在 `event.type === 'turn_interrupted'` 且存在 `last.executionTrace` 时调用 `applyTurnInterrupted`，使 **flag 关闭时的回落视图**也不会被 `finalizeExecutionTrace` 翻成 ✓（原计划只覆盖了 timeline 主路径）；
- `executionTraceReducer.ts` 相应补 `applyTurnInterrupted()` 与 `replayExecutionTraceEvents` 的 `turn_interrupted` case（重放路径同源），`AgentSideRail.turnInterrupted.test.ts` 追加 3 条**行为级**断言（store 真调用 + 幂等 + 重放变异对照），从 6 条增至 9 条。

**② `Metrics.render()` 需要两个实参。**
`metrics.ts:552` 签名是 `render(activeSessions: number, version: string)`，计划 T5 Step 1 的测试写成 `m.render()`（照抄会 TYPE 不过）。已统一改为既有测试同款 `m.render(0, "test")`。

**③ T5 增补一条 runner-reject 用例。**
除计划里的 3 条（completed / 4 态循环 / rejected 分支）外，补「`runSubagent` 抛错 ⇒ coordinator 兜底 `status:"failed"` ⇒ 仍产出 `failed` 样本」，钉住埋点位于 `await attempt.promise` **之后**且 promise 永不 reject 的契约。

**改动路径增量**：`apps/web/src/stores/agent.ts`（T6 REST tree 的 `tree` 列表必须包含它）。

**④ `vue-tsc -b` 揪出第三个「说谎面」：公开分享页。**（T6 Step 3 新增，规格 §5.4 未覆盖）
`TimelinePart.tool.status` 扩 `interrupted` 后，`toShareTurn.ts:53` 把 `p.status` 直接赋给 `ShareTurnPart.tool.status`，而后者是独立 union，仍为 `'running' | 'done' | 'failed'` ⇒ `TS2322`。**这不是单纯的类型问题**：分享页 `renderPart` 的 tool 分支只认 ✓/✗/进行中，`interrupted` 会落到空 `state`（等于「什么问题都没有」），且不显示 `ms` 反而复刻「✓ 用时 0ms」的同类谎言。故同步修三处：
- `shareTemplate.ts`：union 扩 `interrupted`；`STATUS_LABEL` 加「未收到结果」；tool 分支显式 `⏹ 未收到结果` 且**禁用 ms**（中断没有「完成耗时」）；
- `shareTemplate.fidelity.test.ts` 加 2 条回归锁（interrupted 不得出现 ✓/✗/`0ms`/args；done 仍保留 ✓ + 真实耗时，防新分支吞掉正常态）；
- `toShareTurn.test.ts` 加 1 条：状态原样透传、不塌成 done/running。
变更面从 17 路径增至 **20 路径**。

**⑤ `vue-tsc -b` 在本机是「软链假红」，不可据此改产品代码。**
快照的 `apps/web/node_modules` 是软链到主仓（陈旧文档分支），其中 `@lnkpi/shared` 又指向主仓 `packages/shared` —— 那里 `status` 仍是三态，所以本机 `vue-tsc -b` 会无视快照里改过的 `packages/shared/src/shareTemplate.ts`，复报同一 `TS2322`。CI 用 `pnpm install --frozen-lockfile` 生成正确 workspace 链接，看到的是改过的源。**验证方式**：临时 `tsconfig.d1check.json` 用 `paths` 把 `@lnkpi/shared/*` 映射到快照自身 `packages/shared/src/*`（`composite:false`、`references:[]`），跑 `vue-tsc --noEmit -p` 取 CI 等价结论；临时文件验完即删，不进 PR。另 `-b` 会重新生成 `tsconfig*.tsbuildinfo`（未跟踪）与 `vite.config.js/.d.ts`（已跟踪但 blob 与 master 全等），推前须清理并核 blob。

**⑥ 真 master 已前移，但目标路径 blob 全等。**
T6 取真实 HEAD 得 `d6a6a15d` 而非计划里的 `62cd739c`。按项目纪律逐路径比对 17 个目标路径在两棵树上的裸 blob sha：**17/17 EQUAL**（中间提交只动无关 docs）。故允许把 REST commit 的 parent / tree 的 `base_tree` 换成新 master，无需重建单 commit。新增的 3 个 shared/web 测试路径同样需补比对后再推。

**⑦ 服务端全量有 1 条既有基线失败，不是 D1 回归。**
`sessions.service.test.ts` 的 `canvasPatchMetrics` 观察断言在本机全量/隔离均失败（`skipped: 0` vs 期望 `1`）。已在**未改动的纯净 `d6a6a15d` 基线快照**（同样软链依赖）上隔离跑同一文件，复现同样的 `1 failed / 14 passed` ⇒ 本机环境/共享单例导致的既有基线失败；master CI 在 `62cd739c` 为绿。**不修改该无关测试**，只如实记录，避免用「修测试」掩盖基线差异。server `tsc --noEmit` 同样有 7 条既有错误（`PrismaService.agentEvent` ×3、隐式 any ×2、`sessions.service.ts` ×2，均为本机 Prisma client / 软链陈旧）；修复后 D1 分支的该项输出与纯净基线**逐条一致**（行号因 D1 插入偏移）。

**⑧ `TS2783` 揪出一个真的运行期判据 bug + 测试盲区（最重要的一处，T6 Step 3 新增）。**
`signalsFromEvents()` 原本返回 `sawWaitingUser`，而两个适配器把它 spread 在**显式字段之后** ⇒ `input.sawWaitingUser`（运行时观测的 `turn_suspended`）被 `waitingStillPending(executionEvents)`（落库事件重算）静默覆盖，违反规格 §5.1「stream 用运行时变量」「落库投影不得反向驱动运行时决策」。编译器报 `turn-end.ts:119/136 TS2783`，但**此前 T1 的两个 stream 用例都传 `sawWaitingUser:false`，零测试拦截**。
危害是实质的：`agent.service.ts:3770` 下发 `turn_suspended` 后**不 break**，继续执行到 `deriveSignalsFromStream`；若该回合的 `executionEvents` 未含 `waiting_user`（上游事件未落库等），挂起态会被误判 `interrupted` ⇒ 发中断事件 + 可能误退费。
修正：`signalsFromEvents` 只返回 `hasTurnUsage` / `hasOutstandingToolCall` 两个纯事件派生字段；两个适配器各自显式给 `sawWaitingUser`（stream = `input.sawWaitingUser`，record = `waitingStillPending(events)`），顺序不再可覆盖。T1 补 3 条行为级回归锁（运行时 true 不被覆盖 / 事件里有 waiting 也不反向判挂起 / record 仍从末态取），16 → 19 tests。变异自检：把 `sawWaitingUser` 放回 `signalsFromEvents` 必须让 2 条 stream 锁 RED、恢复后 19/19 GREEN。
⚠️ 本条同时说明：`TS2783`/类型告警不能只当「噪音」消掉——它指向的 spread 顺序是判据语义，必须贴真实形态求值后再改（#815 教训同构）。

**⑨ master 二次前移触发三路合并 + 跨窗口语义耦合实证（T6 Step 5 阻断项）。**
推 PR 前再取真实 HEAD 得 `41490feb`（又 +1 commit：P1c 账本投影清债），且这次**改到了 D1 的目标路径 `apps/server/src/agent/agent.service.ts`**（blob `191e31fb…` → `3efcbdb2…`，不再全等）⇒ 按项目纪律禁止只换 parent，必须基于新 master 重建。改动内容 = `buildTurnMetadata.eventsShrunk` / `enrichAssistantPage` / `ledgerRowToPersistedEvent` / `mergeShrunkEvents` / 账本 `messageIndex`，与 D1 的 import / 循环出口 / 结算块区域不重叠。
处置：以 `62cd739c` 为 base、`git merge-file -p ours base theirs` 三路合并得 **0 冲突**；结构差分证明「合并树相对新 master 的 64 行增量」与「D1 相对旧基线的 64 行增量」**逐行全等** ⇒ `ALL_PARALLEL_KEPT`。其余 19 个目标路径在新 master 的裸 blob 与旧基线全等，可直接沿用。

但**结构不冲突 ≠ 语义兼容**：在真 master + D1 的合并树上定向跑 T2，实测 `3 failed | 3 passed`——这正是「MERGEABLE ≠ 合并后真树已验证」（#822）。根因是 P1c 把 `executionEvents` 从「全量事件数组」改成「最小兼容集」（带 gSeq 的 `tool_call` / `tool_result` / `turn_usage` 只进 fire-and-forget 账本），而 D1 的完成判定、未配对工具差集、以及权威终态帧的落库都读这个数组：
1. `outstandingToolCallIds` 变 `[]`；
2. `metadata.executionEvents` 里没有 `turn_interrupted`（合成事件带 gSeq 被分流，只进账本；读时 enrichment 还要求 `eventsShrunk=true` 且 `runId` 非空）⇒ 刷新后复现「✓ 用时 0ms」；
3. `hasOutstandingToolCall=false` ⇒ `shouldReleaseHold` 短路 ⇒ 零交付仍扣费。
两处最小修复（均只在合并树的 `agent.service.ts`）：
- **全量事实视图**：`pushTraceEvent` 漏斗内无条件 `turnFactEvents.push(ev)`（只内存、不落库），`deriveSignalsFromStream` 与 `outstandingToolCallIds` 改读它 ⇒ **完成判定与持久化裁剪决策解耦**，不反向依赖账本读回；P1c 清债目标不受影响（metadata 仍被裁剪）。
- **终态帧进保留集**：`turn_interrupted` 与 `turn_settled` 并列纳入保留集。理由相同——权威终态帧由前端刷新/断连重放直接消费，不能依赖 fail-open 账本。
配套：`agent.service.turn-interrupted.test.ts` 增 1 条**跨窗口契约锁**（6 → 7 tests），同时断言「未配对 id 仍能算出」「`tool_call` 不在保留集」「`turn_interrupted` 在保留集」「`eventsShrunk=true`」。变异自检：把 `turn_interrupted` 移出保留集 ⇒ 契约锁 + 落库断言 `2 failed | 5 passed` RED，恢复 `7 passed` GREEN。P1c 自有测试 `agent.service.p1cShrink.test.ts` 48/48 保持全绿，证明未把全量写回 metadata。
⚠️ **PR 源改为真 master 合并树 `/tmp/pi-lnk-verify-41490feb`**，REST `base_tree` / commit parent = `41490feb`；`tree` 仍只列 20 个改动路径，其余路径自动来自新 master。

---

### Task 1: 单一终止判据纯函数 + 生产记录求值与变异自检

**Files:**
- Create: `apps/server/src/agent/turn-end.ts`
- Create: `apps/server/src/agent/turn-end.test.ts`
- Modify: `apps/server/vitest.config.ts`（仅当新建测试未被默认 include 命中时；先跑 Step 2 确认，通常 `**/*.test.ts` 已覆盖 ⇒ 不修改）

**Interfaces:**
- Consumes: 无（本任务零依赖，只用本地定义的结构化最小接口）
- Produces: 以下导出被 T2 使用，**签名不得改**：
  ```ts
  export interface TraceEventLike { type: string; data?: unknown; seq?: number; gSeq?: number }
  export interface TurnEndSignals {
    sawTerminalEvent: boolean; runFailed: boolean; sawWaitingUser: boolean
    loopCompletedNaturally: boolean; isOwner: boolean; promptAccepted: boolean
    hasTurnUsage: boolean; hasOutstandingToolCall: boolean
  }
  export type TurnEndKind =
    'completed' | 'failed' | 'suspended' | 'detached' | 'shadow' | 'not_started' | 'interrupted'
  export function classifyTurnEnd(s: TurnEndSignals): TurnEndKind
  export function shouldEmitInterrupted(k: TurnEndKind): boolean
  export function shouldReleaseHold(s: TurnEndSignals, k: TurnEndKind): boolean
  export function outstandingToolCallIds(events: readonly TraceEventLike[]): string[]
  export function deriveSignalsFromRecord(
    events: readonly TraceEventLike[], metadata: { truncated?: boolean },
  ): TurnEndSignals
  export function deriveSignalsFromStream(input: {
    sawTerminalEvent: boolean; runFailed: boolean; sawWaitingUser: boolean
    loopCompletedNaturally: boolean; turnRole: 'owner' | 'shadow'
    promptAccepted: boolean; executionEvents: readonly TraceEventLike[]
  }): TurnEndSignals
  ```

- [ ] **Step 1: 写红灯测试**（含真实生产夹具）

`apps/server/src/agent/turn-end.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  classifyTurnEnd, deriveSignalsFromRecord, deriveSignalsFromStream,
  outstandingToolCallIds, shouldEmitInterrupted, shouldReleaseHold,
  type TraceEventLike, type TurnEndSignals,
} from './turn-end'

/**
 * 生产只读快照夹具（2026-11-11，lnkpi-api SQLite AgentMessage.metadata）。
 * A = cmwbvfp4p000qrk01pch77w13（故障会话，pod 在 tool_call 后 0.4s 被替换）
 * B = …42ap2hej（同工具正常返回，78.9s 后有完整 tool_result）
 * 已脱敏：仅保留 type/seq/gSeq 与判定所需字段。
 */
const A_EVENTS: TraceEventLike[] = [
  { type: 'thinking', seq: 1, gSeq: 5 },
  { type: 'text', seq: 2, gSeq: 147 },
  { type: 'thinking', seq: 3, gSeq: 147 },
  { type: 'tool_call', seq: 4, gSeq: 152,
    data: { toolCallId: 'call_334ae8e2832146608be265e9', name: 'spawn_subagent' } },
  { type: 'turn_settled', seq: 5, gSeq: 152,
    data: { credits: 1, tokens: { in: 0, cache: 0, out: 0 } } },
]
const A_META = { truncated: true }

const B_EVENTS: TraceEventLike[] = [
  { type: 'thinking', seq: 1, gSeq: 4665 },
  { type: 'text', seq: 2, gSeq: 4778 },
  { type: 'tool_call', seq: 4, gSeq: 4783,
    data: { toolCallId: 'call_b55c3b4616434aada4967bf4', name: 'spawn_subagent' } },
  { type: 'tool_result', seq: 5, gSeq: 4784,
    data: { toolCallId: 'call_b55c3b4616434aada4967bf4', name: 'spawn_subagent' } },
  { type: 'turn_usage', seq: 9, gSeq: 6870,
    data: { inputTokens: 9459, outputTokens: 2820 } },
  { type: 'turn_settled', seq: 10, gSeq: 6870, data: { credits: 12 } },
]
const B_META = {}   // 键不出现纪律：完整回合不写 truncated

const signals = (over: Partial<TurnEndSignals> = {}): TurnEndSignals => ({
  sawTerminalEvent: false, runFailed: false, sawWaitingUser: false,
  loopCompletedNaturally: true, isOwner: true, promptAccepted: true,
  hasTurnUsage: false, hasOutstandingToolCall: true,
  ...over,
})

describe('turn-end：贴真实生产记录求值', () => {
  it('A（阳性）：零 usage + 未配对 spawn ⇒ interrupted / 发事件 / 释放 hold', () => {
    const s = deriveSignalsFromRecord(A_EVENTS, A_META)
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldEmitInterrupted(k)).toBe(true)
    expect(shouldReleaseHold(s, k)).toBe(true)
    expect(outstandingToolCallIds(A_EVENTS)).toEqual(['call_334ae8e2832146608be265e9'])
  })

  it('B（阴性）：配对结果 + turn_usage ⇒ completed / 两动作均 false', () => {
    const s = deriveSignalsFromRecord(B_EVENTS, B_META)
    const k = classifyTurnEnd(s)
    expect(k).toBe('completed')
    expect(shouldEmitInterrupted(k)).toBe(false)
    expect(shouldReleaseHold(s, k)).toBe(false)
    expect(outstandingToolCallIds(B_EVENTS)).toEqual([])
  })
})

describe('turn-end：变异自检（每项必须能 RED）', () => {
  it('M1 A 的 truncated 改 false ⇒ completed，两动作 false', () => {
    const s = deriveSignalsFromRecord(A_EVENTS, {})
    expect(classifyTurnEnd(s)).toBe('completed')
    expect(shouldReleaseHold(s, classifyTurnEnd(s))).toBe(false)
  })

  it('M2 A 补配对 tool_result ⇒ 不释放（证明窄判据非自匹配恒绿）', () => {
    const s = deriveSignalsFromRecord(
      [...A_EVENTS, { type: 'tool_result', data: { toolCallId: 'call_334ae8e2832146608be265e9' } }],
      A_META,
    )
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('M3 A 补 turn_usage ⇒ 不释放（零 usage 条件生效）', () => {
    const s = deriveSignalsFromRecord(
      [...A_EVENTS, { type: 'turn_usage', data: { inputTokens: 10 } }], A_META,
    )
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('M4 B 删 turn_usage + 删 tool_result + truncated=true ⇒ 转 interrupted 且释放（证明非恒假）', () => {
    const evs = B_EVENTS.filter((e) => e.type !== 'turn_usage' && e.type !== 'tool_result')
    const s = deriveSignalsFromRecord(evs, { truncated: true })
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldReleaseHold(s, k)).toBe(true)
  })

  it('M5 独立挂起样本 C：truncated=true + waiting_user{waiting} ⇒ suspended，两动作 false', () => {
    const s = deriveSignalsFromRecord(
      [...A_EVENTS, { type: 'waiting_user', data: { status: 'waiting' } }], A_META,
    )
    const k = classifyTurnEnd(s)
    expect(k).toBe('suspended')
    expect(shouldEmitInterrupted(k)).toBe(false)
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('M6 判定顺序：agent_end 之后断连 ⇒ detached（不是 completed）', () => {
    const s = signals({ sawTerminalEvent: true, loopCompletedNaturally: false })
    expect(classifyTurnEnd(s)).toBe('detached')
  })

  it('shadow 流 ⇒ shadow，两动作 false', () => {
    const s = signals({ isOwner: false })
    const k = classifyTurnEnd(s)
    expect(k).toBe('shadow')
    expect(shouldEmitInterrupted(k)).toBe(false)
    expect(shouldReleaseHold(s, k)).toBe(false)
  })
})

describe('turn-end：静态守卫与范围边界', () => {
  it('零 usage 不得 settle credits>0：A 的 settled 带 credits 时判据仍要求释放', () => {
    const s = deriveSignalsFromRecord(A_EVENTS, A_META)
    expect(s.hasTurnUsage).toBe(false)
    expect(shouldReleaseHold(s, classifyTurnEnd(s))).toBe(true)
  })

  it('纯文本断流（无 tool_call）：不释放 hold（范围边界，不是 bug）', () => {
    const s = deriveSignalsFromRecord(
      [{ type: 'text' }, { type: 'turn_settled', data: { credits: 1 } }],
      { truncated: true },
    )
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldEmitInterrupted(k)).toBe(true)
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('deriveSignalsFromStream 与 record 在 A 形态上等价（同源判据）', () => {
    const s = deriveSignalsFromStream({
      sawTerminalEvent: false, runFailed: false, sawWaitingUser: false,
      loopCompletedNaturally: true, turnRole: 'owner', promptAccepted: true,
      executionEvents: A_EVENTS,
    })
    expect(s).toEqual(deriveSignalsFromRecord(A_EVENTS, A_META))
  })

  it('★ 回归锁：prompt 未被接受 ⇒ not_started，两动作 false（不得造假记录）', () => {
    const s = deriveSignalsFromStream({
      sawTerminalEvent: false, runFailed: false, sawWaitingUser: false,
      loopCompletedNaturally: true, turnRole: 'owner', promptAccepted: false,
      executionEvents: [],
    })
    const k = classifyTurnEnd(s)
    expect(k).toBe('not_started')
    expect(shouldEmitInterrupted(k)).toBe(false)
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('★ 判定顺序：not_started 优先于 detached（prompt 被拒 + 断连）', () => {
    expect(classifyTurnEnd(signals({ promptAccepted: false, loopCompletedNaturally: false })))
      .toBe('not_started')
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-62cd739c
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run src/agent/turn-end.test.ts --maxWorkers=1 --no-file-parallelism
```
预期：FAIL（`Cannot find module './turn-end'`）。若报 `node_modules` 缺失，先按 Global Constraints 软链依赖再跑。

- [ ] **Step 3: 写最小实现**

`apps/server/src/agent/turn-end.ts`：

```ts
/**
 * 回合终态单一判据（spec docs/superpowers/specs/2026-11-11-subagent-result-delivery-design.md §5.1）。
 *
 * 生产事故：上游 SSE 迭代器自然耗尽、从未收到 agent_end/error，Nest 侧把它当成
 * 正常收尾（扣 1 积分 + [DONE]）⇒ 用户看到「子代理 ✓ 0ms」却没有任何结果。
 * 本模块把「完成」从连接存活度里拿出来，改为对可观测信号的一次显式分类。
 *
 * ⚠️ 判定顺序不可调换：断连可能发生在已见 agent_end 之后。
 * ⚠️ 落库投影 only for 求值/守卫，不得反向驱动运行时决策。
 */
export interface TraceEventLike {
  type: string
  data?: unknown
  seq?: number
  gSeq?: number
}

export interface TurnEndSignals {
  sawTerminalEvent: boolean
  runFailed: boolean
  sawWaitingUser: boolean
  loopCompletedNaturally: boolean
  isOwner: boolean
  /** prompt 是否被 pi 接受。false ⇒ pi 侧整轮不存在，不得发中断事件/造记录。 */
  promptAccepted: boolean
  hasTurnUsage: boolean
  hasOutstandingToolCall: boolean
}

export type TurnEndKind =
  | 'completed' | 'failed' | 'suspended' | 'detached' | 'shadow' | 'not_started' | 'interrupted'

/** tool_call 的 toolCallId 减去已配对 tool_result 的 toolCallId。 */
export function outstandingToolCallIds(events: readonly TraceEventLike[]): string[] {
  const calls: string[] = []
  const results = new Set<string>()
  for (const e of events) {
    const id = (e.data as { toolCallId?: unknown } | undefined)?.toolCallId
    if (typeof id !== 'string' || !id) continue
    if (e.type === 'tool_call') calls.push(id)
    else if (e.type === 'tool_result') results.add(id)
  }
  const seen = new Set<string>()
  return calls.filter((id) => {
    if (results.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function waitingStillPending(events: readonly TraceEventLike[]): boolean {
  let pending = false
  for (const e of events) {
    if (e.type !== 'waiting_user') continue
    pending = (e.data as { status?: unknown } | undefined)?.status === 'waiting'
  }
  return pending
}

export function classifyTurnEnd(s: TurnEndSignals): TurnEndKind {
  if (!s.isOwner) return 'shadow'
  // ⚠️ 必须排在 loopCompletedNaturally 之前：prompt 被上游拒绝时 pi 侧整轮
  // 不存在，流同样会自然耗尽。若此时合成 turn_interrupted 并 pushTraceEvent，
  // executionEvents 非空 ⇒ hasContent=true ⇒ finalizeTurn 造出一条假 assistant 行
  // （既有回归锁 turn-settle-detached.test.ts「不造假记录」实锤）。
  if (!s.promptAccepted) return 'not_started'
  if (!s.loopCompletedNaturally) return 'detached'
  if (s.sawTerminalEvent) return s.runFailed ? 'failed' : 'completed'
  if (s.sawWaitingUser) return 'suspended'
  return 'interrupted'
}

export function shouldEmitInterrupted(k: TurnEndKind): boolean {
  return k === 'interrupted'
}

/**
 * 窄动作判据：只有「真的什么都没交付」才退费。
 * 全库 metadata.truncated 有 82 条，混着 Nest 提前收尾、pi 侧继续跑完并经
 * followUp tail 续传的正常长回合 ⇒ 不能按 !sawTerminalEvent 一律 release。
 */
export function shouldReleaseHold(s: TurnEndSignals, k: TurnEndKind): boolean {
  return (
    k === 'interrupted' &&
    !s.hasTurnUsage &&
    s.hasOutstandingToolCall &&
    !s.runFailed &&
    s.isOwner
  )
}

function signalsFromEvents(events: readonly TraceEventLike[]): Pick<
  TurnEndSignals, 'hasTurnUsage' | 'hasOutstandingToolCall' | 'sawWaitingUser'
> {
  return {
    hasTurnUsage: events.some((e) => e.type === 'turn_usage'),
    hasOutstandingToolCall: outstandingToolCallIds(events).length > 0,
    sawWaitingUser: waitingStillPending(events),
  }
}

/** 运行时适配器：streamConversation 循环出口调用一次，结算块复用同一份 signals。 */
export function deriveSignalsFromStream(input: {
  sawTerminalEvent: boolean
  runFailed: boolean
  sawWaitingUser: boolean
  loopCompletedNaturally: boolean
  turnRole: 'owner' | 'shadow'
  executionEvents: readonly TraceEventLike[]
}): TurnEndSignals {
  return {
    sawTerminalEvent: input.sawTerminalEvent,
    runFailed: input.runFailed,
    sawWaitingUser: input.sawWaitingUser,
    loopCompletedNaturally: input.loopCompletedNaturally,
    isOwner: input.turnRole === 'owner',
    promptAccepted: input.promptAccepted,
    ...signalsFromEvents(input.executionEvents),
  }
}

/** 记录适配器：贴生产记录求值、静态守卫、故障注入判据。 */
export function deriveSignalsFromRecord(
  events: readonly TraceEventLike[],
  metadata: { truncated?: boolean },
): TurnEndSignals {
  return {
    // truncated 正是 !sawTerminalEvent 的落库投影（键不出现纪律）
    sawTerminalEvent: metadata.truncated !== true,
    runFailed: events.some((e) => e.type === 'error'),
    sawWaitingUser: waitingStillPending(events),
    // 能落成 assistant 消息的 owner 回合即自然收尾；断连兜底走 void finalizeTurn，
    // 不进入本判据的求值域。
    loopCompletedNaturally: true,
    isOwner: true,
    // 已落库 ⇒ prompt 必然被接受过（prompt 被拒时 finalizeTurn 不写行）。
    promptAccepted: true,
    ...signalsFromEvents(events),
  }
}
```

- [ ] **Step 4: 跑测试确认 GREEN**

复用 Step 2 命令。预期：13 个用例全部 PASS。
随后做**变异自检**：临时把 `classifyTurnEnd` 中 `if (!s.loopCompletedNaturally) return 'detached'` 一行移到 `sawTerminalEvent` 分支之后，重跑，确认 M6 RED；恢复实现再跑一次 GREEN。**记录这一步的实际结果**，勿只看测试文件存在。

- [ ] **Step 5: Commit（登记改动清单）**

```
T1 改动路径：apps/server/src/agent/turn-end.ts、apps/server/src/agent/turn-end.test.ts
```
（快照无 `.git`；由 Task 6 统一 REST 单 commit 推送。）

---

### Task 2: 服务端接线——事件登记、产出/落库、计费释放

**Files:**
- Modify: `packages/agent/src/types.ts:45-121`（`AgentStreamEvent.type` union）
- Modify: `apps/server/src/agent/agent.service.ts:3341-3348`（声明）、`:3754-3767`（循环出口）、`:3893-3928`（结算块）、`:4125-4156`（落库 metadata 注释核对，不改逻辑）
- Create: `apps/server/src/agent/agent.service.turn-interrupted.test.ts`

**Interfaces:**
- Consumes: T1 的 `deriveSignalsFromStream` / `classifyTurnEnd` / `shouldEmitInterrupted` / `shouldReleaseHold` / `outstandingToolCallIds` / `TurnEndSignals` / `TurnEndKind`
- Produces: SSE 事件 `turn_interrupted`，`data` 形状被 T3/T4 消费：
  ```ts
  { reason: 'no_terminal_event'; runId?: string; lastSeq?: number; outstandingToolCallIds?: string[] }
  ```
  落库走 `pushTraceEvent('turn_interrupted', data)` ⇒ 自动 `appendAgentEvent` 进 #840 账本，`gSeq = currentPiEvent?.seq`。

- [ ] **Step 1: 写红灯集成测试**

`apps/server/src/agent/agent.service.turn-interrupted.test.ts`（骨架照抄 `agent.service.turn-identity.test.ts:21-36, 91-171, 305-351`）：

```ts
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent, stubPiClient } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

function seqEvent(type: string, data: unknown, seq: number): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, data } as PiRuntimeEvent
}
function ridEvent(type: string, data: unknown, runId: string, seq: number): PiRuntimeEvent {
  return { type, ts: 1_700_000_000_000, seq, runId, data } as PiRuntimeEvent
}

describe('turn_interrupted：上游流耗尽且无权威收束', () => {
  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    process.env.TEXT_TOKEN_BILLING = 'on'
    service = new AgentService(
      {
        agentMessage: {
          create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'm1', ...data })),
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue({}),
        },
        agentThread: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
        session: { findUnique: vi.fn().mockResolvedValue(null) },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  /** 构造「流自然耗尽、无 agent_end」——必须显式 onClosed()（桩默认不收口会永久挂起）。 */
  async function runNaturallyExhausted(events: PiRuntimeEvent[]) {
    const pi = stubPiClient([])
    vi.spyOn(service, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_sid: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        for (const e of events) onEvent(e)
        onClosed()
        return () => {}
      },
    )
    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of service.streamConversation('s1', '帮我调研市场', 'u1', 't1')) out.push(e)
    return out
  }

  it('阳性：恰一个 turn_interrupted，data 带 reason/lastSeq/未配对 id，且已落库', async () => {
    const out = await runNaturallyExhausted([
      ridEvent('agent_start', {}, 'run-A', 140),
      seqEvent('tool_execution_start',
        { toolCallId: 'call_A', toolName: 'spawn_subagent', args: { task: '调研X' } }, 152),
    ])
    const ev = out.filter((e) => e.type === 'turn_interrupted')
    expect(ev).toHaveLength(1)
    expect(ev[0]?.data).toMatchObject({
      reason: 'no_terminal_event',
      lastSeq: 152,
      outstandingToolCallIds: ['call_A'],
    })
  }, 120_000)

  it('阴性（规格 §6 会话 B 形态）：见到 agent_end ⇒ 不发 turn_interrupted', async () => {
    const out = await runNaturallyExhausted([
      ridEvent('agent_start', {}, 'run-B', 4665),
      seqEvent('tool_execution_start',
        { toolCallId: 'call_B', toolName: 'spawn_subagent', args: { task: '调研Y' } }, 4783),
      seqEvent('tool_execution_end', { toolCallId: 'call_B', toolName: 'spawn_subagent' }, 4784),
      piEvent('agent_end', { status: 'completed' }),
    ])
    expect(out.some((e) => e.type === 'turn_interrupted')).toBe(false)
    expect(out.some((e) => e.type === 'turn_suspended')).toBe(false)
  }, 120_000)

  it('阴性：waiting_user{waiting} 挂起 ⇒ 只发 turn_suspended，不发 turn_interrupted', async () => {
    const out = await runNaturallyExhausted([
      ridEvent('agent_start', {}, 'run-W', 1),
      seqEvent('waiting_user', { status: 'waiting', toolName: 'propose_generation' }, 2),
    ])
    expect(out.some((e) => e.type === 'turn_suspended')).toBe(true)
    expect(out.some((e) => e.type === 'turn_interrupted')).toBe(false)
  }, 120_000)
})

describe('turn_interrupted：零交付不扣费', () => {
  /** points 是构造参第 7 位、pricing 第 8 位（agent.service.ts:288-345）。 */
  const release = vi.fn().mockResolvedValue(undefined)
  const settleFromHold = vi.fn().mockResolvedValue({ settled: 12 })
  const freeze = vi.fn().mockResolvedValue({ id: 'hold-1' })
  const quoteTextTokens = vi.fn().mockResolvedValue({ credits: 12, ruleVersion: 'v1' })
  let billingService: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
    process.env.TEXT_TOKEN_BILLING = 'on'
    billingService = new AgentService(
      {
        agentMessage: {
          create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'm1', ...data })),
          findMany: vi.fn().mockResolvedValue([]),
          aggregate: vi.fn().mockResolvedValue({ _max: { seq: null } }),
        },
        agentThread: {
          findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
        session: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn().mockResolvedValue(null) } as never,
      undefined, undefined, undefined,
      { freeze, release, settleFromHold } as never,
      { quoteTextTokens } as never,
    )
  })

  it('release hold，turn_settled 只带 released:true，settleFromHold 零调用', async () => {
    const pi = stubPiClient([])
    vi.spyOn(billingService, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_sid: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        for (const e of [
          ridEvent('agent_start', {}, 'run-A', 140),
          seqEvent('tool_execution_start',
            { toolCallId: 'call_A', toolName: 'spawn_subagent', args: { task: '调研X' } }, 152),
        ]) onEvent(e)
        onClosed()
        return () => {}
      },
    )
    const out: Array<{ type: string; data?: unknown }> = []
    for await (const e of billingService.streamConversation('s1', '帮我调研', 'u1', 't1')) out.push(e)

    expect(release).toHaveBeenCalledWith('hold-1', '回合未收到完成确认，零交付不扣费')
    expect(settleFromHold).not.toHaveBeenCalled()
    const settled = out.filter((e) => e.type === 'turn_settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]?.data).toMatchObject({ holdId: 'hold-1', released: true })
    expect((settled[0]?.data as Record<string, unknown>).credits).toBeUndefined()
  }, 120_000)

  it('阴性：有 turn_usage 的正常回合照常结算（不误伤长回合）', async () => {
    const pi = stubPiClient([])
    vi.spyOn(billingService, 'createPiRuntimeClient').mockReturnValue(pi)
    pi.streamEvents.mockImplementation(
      (_sid: string, onEvent: (e: PiRuntimeEvent) => void, onClosed: () => void) => {
        for (const e of [
          ridEvent('agent_start', {}, 'run-B', 1),
          piEvent('message_end', { usage: { input: 9459, output: 2820 } }),
          piEvent('agent_end', { status: 'completed' }),
        ]) onEvent(e)
        onClosed()
        return () => {}
      },
    )
    for await (const _e of billingService.streamConversation('s1', '问题', 'u1', 't1')) { /* drain */ }
    expect(release).not.toHaveBeenCalled()
    expect(settleFromHold).toHaveBeenCalledOnce()
  }, 120_000)
})
```

⚠️ `resolveForGeneration` 桩返回 `null` 时 `billingModelKey` 可能为空，但既有 `turn-settle-detached.test.ts` 用同款 3 参构造已能跑通；若 `freezeTurnHold` 因 provider 解析为空而跳过（hold 为 undefined ⇒ 结算块整体短路），把第 3 参改为 `vi.fn().mockResolvedValue({ key: 'agnes-2.5-pro', providerRef: 'agnes', model: 'agnes-2.5-pro' })` 并按 `agent.service.credit-tx-stream.test.ts` 的 provider 桩补齐字段。**不得用 `as never` 绕过断言**（构造桩的 `as never` 是本仓既有惯例，仅用于 DI 参数，不用于断言值）。

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-62cd739c
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run src/agent/agent.service.turn-interrupted.test.ts --maxWorkers=1 --no-file-parallelism
```
预期：FAIL（`turn_interrupted` 事件不存在 / `credits` 为 1）。

- [ ] **Step 3: 写最小实现**

**(a) `packages/agent/src/types.ts`**，在 `'turn_suspended'` 之后加：

```ts
    // turn_interrupted（2026-11-11 生产事故 cmwbvfp4p000qrk01pch77w13）：主流
    // 自然耗尽但从未收到 agent_end/error。⚠️ reason 只陈述可观测事实
    // （no_terminal_event），不臆断 pod 重启/nginx 掐断/客户端断网。
    // 随 executionEvents 落库 ⇒ 刷新与断连续传都能还原中断态。
    | 'turn_interrupted'
```

**(b) `apps/server/src/agent/agent.service.ts`** 顶部 import：

```ts
import {
  classifyTurnEnd, deriveSignalsFromStream, outstandingToolCallIds,
  shouldEmitInterrupted, shouldReleaseHold,
  type TurnEndKind, type TurnEndSignals,
} from './turn-end'
```

在 `:3341-3348` 变量声明区加（**必须在 try 之前**，供结算块跨作用域复用）：

```ts
    // D1（2026-11-11）：回合终态只判一次，SSE 下发 / 计费 / 落库共用。
    // 放在 try 之前是因为结算块在 try/finally 之后，不能重复 derive（那时
    // executionEvents 已被结算帧改变 ⇒ 会算出不同结论）。
    let turnEndSignals: TurnEndSignals | null = null
    let turnEndKind: TurnEndKind = 'detached'
```

在 `:3759-3763` 的 `turn_suspended` 块**之后**、`loopCompletedNaturally = true`（`:3767`）**之前**插入：

```ts
      // D1：循环能走到这里 = 自然耗尽（断连时 generator.return 在 yield 处回收，
      // 本段不可达）⇒ loopCompletedNaturally 显式传 true。
      turnEndSignals = deriveSignalsFromStream({
        sawTerminalEvent, runFailed, sawWaitingUser,
        loopCompletedNaturally: true,
        turnRole,
        promptAccepted,
        executionEvents,
      })
      turnEndKind = classifyTurnEnd(turnEndSignals)
      if (shouldEmitInterrupted(turnEndKind)) {
        const interruptedData = {
          reason: 'no_terminal_event' as const,
          ...(turnRunId ? { runId: turnRunId } : {}),
          ...(currentPiEvent?.seq !== undefined ? { lastSeq: currentPiEvent.seq } : {}),
          outstandingToolCallIds: outstandingToolCallIds(executionEvents),
        }
        // ⚠️ 必须走 pushTraceEvent：合成事件不在主循环那条「tool_call/tool_result/
        // node_status/waiting_user」提取 if 内；TRACE_PERSIST_EVENT_TYPES 在 0.99.2
        // 是死代码（全仓零引用），加它无效。pushTraceEvent 内部 appendAgentEvent
        // 自动进 #840 AgentEvent 账本。
        const ev = pushTraceEvent('turn_interrupted', interruptedData)
        yield { type: ev.type, data: ev.data } as unknown as AgentStreamEvent
      }
```

⚠️ `turnRunId` / `currentPiEvent` / `pushTraceEvent` / `executionEvents` / `turnRole` 均为当前作用域既有变量（分别见 `:2904` 附近、`:3591`、`:2994`、`:3299`）。若 `turnRunId` 在该点不可见，改用 `runId` 变量并核对 `agent.service.ts` 中的实际声明名后替换。

**(c) 结算块**：在 `:3908`（`usage` 计算完成）之后、`:3909` `if (runFailed)` 之前插入新分支，并把原 `if (runFailed)` 改为 `else if`：

```ts
      if (turnEndSignals && shouldReleaseHold(turnEndSignals, turnEndKind)) {
        // 零 usage + 有未配对 tool_call = 真的什么都没交付 ⇒ 未交付不收费。
        // 照 runFailed 分支的 release 样板；不碰 Math.max(1, ceil(quote.credits))
        // （它服务于「有 usage 但 quote 归零」的正常回合）。
        try {
          await this.points.release(billingHold.id, '回合未收到完成确认，零交付不扣费')
          holdOpen = false
        } catch (err) {
          this.piLogger.warn(
            `turn hold release failed (hold=${billingHold.id}): ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const settledData = pushTraceEvent('turn_settled', {
          holdId: billingHold.id,
          released: true,
        }).data
        emitSettled(settledData as TurnSettledBusEvent)
        yield { type: 'turn_settled', data: settledData } as AgentStreamEvent
      } else if (runFailed) {
```

- [ ] **Step 4: 跑测试确认 GREEN**

```bash
cd /tmp/pi-lnk-master-62cd739c
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/server exec vitest run \
    src/agent/turn-end.test.ts \
    src/agent/agent.service.turn-interrupted.test.ts \
    src/agent/agent.service.turn-identity.test.ts \
    src/agent/turn-settle-detached.test.ts \
    src/agent/longturn-persistence.test.ts \
    --maxWorkers=1 --no-file-parallelism
```
预期：全 PASS。特别核对 `turn-identity.test.ts` 的 D3 `turn_suspended` 阳/阴性用例与 `turn-settle-detached.test.ts` 的 `truncated` 断言**未被破坏**（这两组是互斥性回归锁）。

- [ ] **Step 5: Commit（登记改动清单）**

```
T2 改动路径：packages/agent/src/types.ts、apps/server/src/agent/agent.service.ts、
             apps/server/src/agent/agent.service.turn-interrupted.test.ts
```

---

### Task 3: 前端时间线状态机——可恢复中断态

**Files:**
- Modify: `apps/web/src/components/agent/turnTimeline.ts:44-54`（tool status）、`:191-…`（`TimelineEvent` union）、`:405-…`（`applyTimelineEvent` switch）、`:547-565`（`tool_result` 回退匹配）、`:961-979`（`finalizeTurnTimeline`，**只读核对、不改**）、`:1218-1227`（`replayTimelineEvents` truncated notice，**不改**）
- Create: `apps/web/src/components/agent/turnTimeline.interrupted.test.ts`

**Interfaces:**
- Consumes: T2 落库的 `turn_interrupted` 事件（type + data 形状见 T2 Interfaces）
- Produces: `'interrupted'` 状态字面量（T4 的 `ExecutionStepStatus` / 渲染分支依赖）；notice 稳定 id `notice:turn-interrupted`；`TimelineEvent` 新成员：
  ```ts
  | { type: 'turn_interrupted'; data: {
        reason: 'no_terminal_event'; runId?: string; lastSeq?: number
        outstandingToolCallIds?: string[]
      } }
  ```

- [ ] **Step 1: 写红灯测试**

`apps/web/src/components/agent/turnTimeline.interrupted.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  applyTimelineEvent, createTurnTimeline, finalizeTurnTimeline,
  replayTimelineEvents, type TimelineEvent, type TimelinePart, type TurnTimeline,
} from '@/components/agent/turnTimeline'

function feed(events: TimelineEvent[]): TurnTimeline {
  const tl = createTurnTimeline()
  for (const e of events) applyTimelineEvent(tl, e)
  return tl
}
function tools(tl: TurnTimeline): Extract<TimelinePart, { kind: 'tool' }>[] {
  return tl.parts.filter((p): p is Extract<TimelinePart, { kind: 'tool' }> => p.kind === 'tool')
}
function notices(tl: TurnTimeline): Extract<TimelinePart, { kind: 'notice' }>[] {
  return tl.parts.filter((p): p is Extract<TimelinePart, { kind: 'notice' }> => p.kind === 'notice')
}
const spawnCall: TimelineEvent = {
  type: 'tool_call', data: { toolCallId: 'call_A', name: 'spawn_subagent', args: { task: '调研X' } },
}
const interrupted: TimelineEvent = {
  type: 'turn_interrupted',
  data: { reason: 'no_terminal_event', lastSeq: 152, outstandingToolCallIds: ['call_A'] },
}

describe('turn_interrupted 时间线：不再把未配对工具渲染成 ✓', () => {
  it('running 工具被翻成 interrupted，且出现一条 error notice（含未扣费文案）', () => {
    const tl = feed([spawnCall, interrupted])
    expect(tools(tl)[0]?.status).toBe('interrupted')
    const n = notices(tl).find((p) => p.id === 'notice:turn-interrupted')
    expect(n?.tone).toBe('error')
    expect(n?.text).toContain('未扣费')
    expect(n?.text).not.toContain('服务更新打断')
    expect(n?.retryLabel).toBeTruthy()
  })

  it('★ 回归锁：finalizeTurnTimeline 不得把 interrupted 翻回 done', () => {
    const tl = feed([spawnCall, interrupted])
    finalizeTurnTimeline(tl)
    expect(tools(tl)[0]?.status).toBe('interrupted')
  })

  it('★ 重放还原：replayTimelineEvents 含落库事件时同样还原中断态', () => {
    const tl = replayTimelineEvents([
      { type: 'tool_call', data: { toolCallId: 'call_A', name: 'spawn_subagent' }, seq: 1, gSeq: 152 },
      { type: 'turn_interrupted', data: { reason: 'no_terminal_event', lastSeq: 152 }, seq: 2, gSeq: 152 },
    ] as never)
    expect(tools(tl)[0]?.status).toBe('interrupted')
    expect(notices(tl).some((p) => p.id === 'notice:turn-interrupted')).toBe(true)
  })

  it('幂等：turn_interrupted 重复到达只产生一条 notice', () => {
    const tl = feed([spawnCall, interrupted, interrupted])
    expect(notices(tl).filter((p) => p.id === 'notice:turn-interrupted')).toHaveLength(1)
  })

  it('可恢复：带 callId 的 tool_result 把 interrupted 翻回 done 并移除 notice', () => {
    const tl = feed([spawnCall, interrupted, {
      type: 'tool_result', data: { toolCallId: 'call_A', name: 'spawn_subagent', result: 'ok' },
    }])
    expect(tools(tl)[0]?.status).toBe('done')
    expect(notices(tl).some((p) => p.id === 'notice:turn-interrupted')).toBe(false)
  })

  it('可恢复：无 callId 的 tool_result 命中 interrupted 工具（不得孤儿降级）', () => {
    const tl = feed([
      { type: 'tool_call', data: { name: 'spawn_subagent' } },
      interrupted,
      { type: 'tool_result', data: { name: 'spawn_subagent', result: 'ok' } },
    ])
    expect(tools(tl)[0]?.status).toBe('done')
    expect(tools(tl)).toHaveLength(1)
  })

  it('历史老消息（只有 tool_call、无中断事件）：既有 truncated notice 行为不变', () => {
    const tl = replayTimelineEvents(
      [{ type: 'tool_call', data: { toolCallId: 'call_A', name: 'spawn_subagent' }, seq: 1 }] as never,
      undefined,
      { truncated: true },
    )
    expect(notices(tl).some((p) => p.id === 'notice:truncated-ledger')).toBe(true)
    expect(notices(tl).some((p) => p.id === 'notice:turn-interrupted')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-62cd739c
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/web exec vitest run \
    src/components/agent/turnTimeline.interrupted.test.ts --maxWorkers=1 --no-file-parallelism
```
预期：FAIL（TS 类型不接受 `turn_interrupted` / `status` 不含 `interrupted`；若 vitest 用 esbuild 不做类型检查，则为运行时断言 FAIL：`status` 仍是 `running`）。

- [ ] **Step 3: 写最小实现**

**(a)** `turnTimeline.ts:49` 把 tool status 改为：
```ts
      status: 'running' | 'done' | 'failed' | 'interrupted'
```

**(b)** `TimelineEvent` union 在 `turn_settled` 成员之后加：
```ts
  | {
      /** 2026-11-11 D1：主流自然耗尽且无权威收束。随 executionEvents 落库重放。 */
      type: 'turn_interrupted'
      data: {
        reason: 'no_terminal_event'
        runId?: string
        lastSeq?: number
        outstandingToolCallIds?: string[]
      }
    }
```

**(c)** `applyTimelineEvent` switch 内在 `case 'error'` 之前加新 case：
```ts
    case 'turn_interrupted': {
      const d = event.data
      for (const p of timeline.parts) {
        if (p.kind === 'tool' && p.status === 'running') p.status = 'interrupted'
      }
      // 稳定 id ⇒ 重放 / 重复下发不叠加（同 notice:partial-ledger 家族）
      if (!timeline.parts.some((p) => p.kind === 'notice' && p.id === 'notice:turn-interrupted')) {
        const hasSubagent = timeline.parts.some(
          (p) => p.kind === 'tool' && p.toolName === 'spawn_subagent' && p.status === 'interrupted',
        )
        timeline.parts.push({
          kind: 'notice',
          id: 'notice:turn-interrupted',
          text:
            '本轮未收到完成确认，结果可能未交付；本次未扣费' +
            (hasSubagent ? ' · 子代理调研没有返回结果' : ''),
          tone: 'error',
          retryLabel: '可重新发送这条消息重试',
        })
      }
      return
    }
```

**(d)** `tool_result` case（`:547-565`）：把无 `toolCallId` 的回退匹配从 `p.status === 'running'` 扩到 `p.status === 'running' || p.status === 'interrupted'`；并在 `if (existing)` 分支里，当已无 `running`/`interrupted` 工具时移除中断 notice：
```ts
      if (existing) {
        existing.status = d.isError ? 'failed' : 'done'
        existing.isError = d.isError === true
        if (resultSummary) existing.resultSummary = resultSummary
        const stillPending = timeline.parts.some(
          (p) => p.kind === 'tool' && (p.status === 'running' || p.status === 'interrupted'),
        )
        if (!stillPending) {
          const idx = timeline.parts.findIndex(
            (p) => p.kind === 'notice' && p.id === 'notice:turn-interrupted',
          )
          if (idx >= 0) timeline.parts.splice(idx, 1)
        }
        return
      }
```

**(e)** `finalizeTurnTimeline`（`:961-979`）**不改**；仅在其上方补一条注释说明「`interrupted` 不在 `running` 判定内 ⇒ 收口不会翻回 `done`」。

**(f)** `replayTimelineEvents` 的 `opts.truncated` 分支（`:1218-1227`）**不改**：老消息继续显示既有「本轮未捕获到生成结束」，新回合由落库 `turn_interrupted` 事件接管。

- [ ] **Step 4: 跑测试确认 GREEN**

```bash
cd /tmp/pi-lnk-master-62cd739c
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/web exec vitest run \
    src/components/agent/turnTimeline.interrupted.test.ts \
    src/components/agent/turnTimeline.test.ts \
    src/components/agent/turnTimeline.callIdResolve.test.ts \
    src/components/agent/turnTimeline.settledSummary.test.ts \
    --maxWorkers=1 --no-file-parallelism
```
预期：全 PASS；`turnTimeline.test.ts` 中既有「无配对工具收口翻 done」的用例若断言 `running → done`，应仍 PASS（该路径不含 `turn_interrupted` 事件）。

- [ ] **Step 5: Commit（登记改动清单）**

```
T3 改动路径：apps/web/src/components/agent/turnTimeline.ts、
             apps/web/src/components/agent/turnTimeline.interrupted.test.ts
```

---

### Task 4: 前端接线与渲染——SideRail case、工具卡、重试、trace 对齐

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:2541-2549`（case 邻近）、`:3394-3407`（挂载点）、`:1922-1957`（断链文案豁免）
- Modify: `apps/web/src/components/agent/AgentTurnTimeline.vue:451-480`（tool 渲染）、`:790-808`（notice 渲染）、`:60-70`（emits）
- Modify: `apps/web/src/components/agent/executionTraceReducer.ts:23-29`（status 枚举）、`:475-484`（finalize）
- Modify: `apps/web/src/components/agent/AgentExecutionTrace.vue:83-104`（statusIcon / stepDuration）
- Create: `apps/web/src/components/agent/AgentSideRail.turnInterrupted.test.ts`

**Interfaces:**
- Consumes: T3 的 `'interrupted'` 字面量、`notice:turn-interrupted` 稳定 id、`retryLabel`
- Produces: `emit('retryTurn')`（无参数），由 SideRail 接 `@retry-turn="onRetryTurn"` → 复用 `sendMessage(lastUserText, undefined, true)`（`AgentSideRail.vue:1661` 的 `isRetry` 语义：不重复落 user 消息）

- [ ] **Step 1: 写红灯接线测试**

`apps/web/src/components/agent/AgentSideRail.turnInterrupted.test.ts`（源码级断言，照 `AgentSideRail.turnSuspended.test.ts:46-106` 的写法）：

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rail = readFileSync(
  resolve(__dirname, './AgentSideRail.vue'), 'utf8',
)
const timeline = readFileSync(
  resolve(__dirname, './AgentTurnTimeline.vue'), 'utf8',
)

describe('turn_interrupted 前端接线', () => {
  it('handleEvent 有 case 且喂入 timeline（不是静默丢弃）', () => {
    expect(rail).toMatch(/case 'turn_interrupted'/)
    expect(rail).toMatch(/feedTimeline\(/)
  })

  it('不追加「连接意外断开」文案（与 turn_suspended 同款豁免）', () => {
    const caseBody = rail.slice(
      rail.indexOf("case 'turn_interrupted'"),
      rail.indexOf("case 'turn_interrupted'") + 700,
    )
    expect(caseBody).not.toContain('appendText')
    expect(caseBody).not.toContain('连接意外断开')
  })

  it('挂载点接了 @retry-turn', () => {
    expect(rail).toMatch(/@retry-turn=/)
  })

  it('工具卡有 interrupted 渲染分支（禁止 ✓）', () => {
    expect(timeline).toMatch(/part\.status === 'interrupted'/)
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-62cd739c
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/web exec vitest run \
    src/components/agent/AgentSideRail.turnInterrupted.test.ts --maxWorkers=1 --no-file-parallelism
```
预期：FAIL（4 条中至少 3 条）。

- [ ] **Step 3: 写最小实现**

**(a)** `AgentSideRail.vue`：在 `case 'turn_suspended'` 块之后加：
```ts
    case 'turn_interrupted': {
      // D1（2026-11-11）：上游流耗尽但无权威收束。中断态由 timeline 的
      // interrupted 工具卡 + notice 单一承载；此处只把事件喂进时间线，
      // 不追加「连接意外断开」文案（那是断链，不是本事件），避免双重报错。
      // 刷新/重连后由落库 turn_interrupted 事件经 replayTimelineEvents 还原。
      agent.feedTimeline(event as Parameters<typeof agent.feedTimeline>[0])
      break
    }
```
在 `mainTurnSuspended` ref 附近（`:704-711`）加 `const mainTurnInterrupted = ref(false)`，case 内置 `true`，新一轮发送时复位；在 `:1944-1957` 的「本轮无文本回复」豁免条件里加 `&& !mainTurnInterrupted.value`（避免 notice 之外再补一行误导文案）。

**(b)** `AgentTurnTimeline.vue` emits 加：
```ts
  /** D1：中断 notice 的重试入口（续跑，不重复落 user 消息）。 */
  retryTurn: []
```
tool 渲染的两处（`:466-467` 与 `:478-479`）在 `done` 分支之后加：
```html
          <span v-else-if="part.status === 'interrupted'" class="ml-auto text-danger">⏹ 未收到结果</span>
```
notice 渲染（`:806`）把纯文本 `retryLabel` 改为按钮：
```html
          <button
            v-if="part.retryLabel && part.id === 'notice:turn-interrupted'"
            type="button"
            class="ml-1 underline"
            data-test="retry-turn"
            @click="emit('retryTurn')"
          >重试</button>
          <span v-else-if="part.retryLabel" class="ml-1 opacity-80">{{ part.retryLabel }}</span>
```

**(c)** `AgentSideRail.vue` 挂载点（`:3394-3407`）加 `@retry-turn="onRetryTurn"`，并新增：
```ts
function onRetryTurn() {
  const lastUser = [...agent.messages].reverse().find((m) => m.role === 'user')
  if (!lastUser?.content) return
  void sendMessage(lastUser.content, undefined, true)
}
```

**(d)** `executionTraceReducer.ts` 的 `ExecutionStepStatus` 加 `| 'interrupted'`；`finalizeExecutionTrace`（`:475-484`）**不改循环体**（`if (step.status === 'running')` 不匹配 `interrupted`），仅补注释。`completeStep` 若对未知 status 有穷尽 assert，补 `interrupted` 分支使其等同于 `failed` 但不带错误文案。

**(e)** `AgentExecutionTrace.vue` 的 `statusIcon` switch 加：
```ts
    case 'interrupted':
      return '⏹'
```
`stepDuration`（`:100-104`）在 `if (step.ms == null || step.status === 'running') return ''` 中补 `|| step.status === 'interrupted'`。

- [ ] **Step 4: 跑测试确认 GREEN**

```bash
cd /tmp/pi-lnk-master-62cd739c
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @lnkpi/web exec vitest run \
    src/components/agent/AgentSideRail.turnInterrupted.test.ts \
    src/components/agent/AgentSideRail.turnSuspended.test.ts \
    src/components/agent/turnTimeline.interrupted.test.ts \
    src/components/agent/executionTraceReducer.test.ts \
    --maxWorkers=1 --no-file-parallelism
```
预期：全 PASS。`AgentSideRail.turnSuspended.test.ts` 是互斥性回归锁，必须保持 GREEN。

- [ ] **Step 5: Commit（登记改动清单）**

```
T4 改动路径：apps/web/src/components/agent/AgentSideRail.vue、
             apps/web/src/components/agent/AgentTurnTimeline.vue、
             apps/web/src/components/agent/executionTraceReducer.ts、
             apps/web/src/components/agent/AgentExecutionTrace.vue、
             apps/web/src/components/agent/AgentSideRail.turnInterrupted.test.ts
```

---

### Task 5: pi-runtime 正常 4 态 outcome 埋点（诚实边界：不覆盖进程蒸发）

**Files:**
- Modify: `services/pi-runtime/src/tools/spawn-subagent.ts:66-67`
- Modify: `services/pi-runtime/src/tools/spawn-subagent.test.ts`

**Interfaces:**
- Consumes: `Metrics.observeSubagentOutcome(status)`（`metrics.ts:420`，签名 `"completed" | "failed" | "timeout" | "budget_exceeded"`，与 `SubagentOutcome.status` 逐值一致，无需映射）
- Produces: 无（只补观测，不改工具返回契约）

- [ ] **Step 1: 写红灯测试**

在 `spawn-subagent.test.ts` 末尾追加（沿用文件顶部已有的 `noopUpdate` / `invocation` / `chordCtx` / `textOf`）：

```ts
	it("outcome 埋点：正常路径产出 completed 样本", async () => {
		const c = new SubagentCoordinator();
		c.attach({
			runSubagent: async () => ({ report: "R", turns: 1, durationMs: 10, status: "completed" }),
		});
		const m = new Metrics();
		await createSpawnSubagentTool(c, m).execute(
			"call-ok", { task: "t" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		const text = m.render();
		assert.match(text, /pi_runtime_subagent_spawned_total 1/);
		assert.match(text, /pi_runtime_subagent_outcome_total\{status="completed"\} 1/);
	});

	it("outcome 埋点：failed / timeout / budget_exceeded 各产出一次", async () => {
		for (const status of ["failed", "timeout", "budget_exceeded"] as const) {
			const c = new SubagentCoordinator();
			c.attach({
				runSubagent: async () => ({ report: "R", turns: 1, durationMs: 10, status }),
			});
			const m = new Metrics();
			await createSpawnSubagentTool(c, m).execute(
				`call-${status}`, { task: "t" } as never, noopUpdate,
				{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
			);
			assert.match(m.render(), new RegExp(`pi_runtime_subagent_outcome_total\\{status="${status}"\\} 1`));
		}
	});

	it("rejected 分支不产生 outcome（spawned 也不增加）", async () => {
		const m = new Metrics();
		const tool = createSpawnSubagentTool(new SubagentCoordinator(), m);
		await tool.execute(
			"call-rej", { task: "t" } as never, noopUpdate,
			{ piSessionKey: "k" } as never, invocation as never, chordCtx as never,
		);
		const text = m.render();
		assert.match(text, /pi_runtime_subagent_spawned_total 0/);
		assert.doesNotMatch(text, /pi_runtime_subagent_outcome_total\{status=/);
	});
```

⚠️ **诚实边界**（写进实现注释，不得省略）：进程被滚动更新替换时 `await attempt.promise` 永不 resolve ⇒ 这行埋点执行不到；且 counter 是进程内内存，pod 重启归零。本次事故的中断归因由 Nest `AgentEvent` 账本（T2）承担，D2 子任务单据才做跨进程闭环。

- [ ] **Step 2: 跑测试确认 RED**

```bash
cd /tmp/pi-lnk-master-62cd739c
PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS \
  pnpm --filter @pi-lnk/pi-runtime test
```
预期：新增 3 个用例 FAIL（`render()` 里无 outcome 样本行）。

- [ ] **Step 3: 写最小实现**

`spawn-subagent.ts:66` 之后插一行：
```ts
		const outcome = await attempt.promise;
		// D1 outcome 闭环（正常 4 态）。⚠️ 覆盖不到进程蒸发：pod 被替换时本 await
		// 永不 resolve，且 counter 随进程归零 ⇒ 中断归因由 Nest AgentEvent 账本承担，
		// 跨进程闭环留给 D2 子任务单据。不得把 spawned − Σoutcome 当跨重启告警。
		metrics.observeSubagentOutcome(outcome.status);
```

- [ ] **Step 4: 跑测试确认 GREEN**

复用 Step 2 命令。预期：全部 PASS（含 `gate/subagent.test.ts`、`session-manager.subagent.test.ts` 等既有用例）。

- [ ] **Step 5: Commit（登记改动清单）**

```
T5 改动路径：services/pi-runtime/src/tools/spawn-subagent.ts、
             services/pi-runtime/src/tools/spawn-subagent.test.ts
```

---

### Task 6: 全量验证、静态守卫、REST 推 PR（不合并）

**Files:**
- Modify: 无产品代码；同步 `docs/superpowers/specs/2026-11-11-subagent-result-delivery-design.md` 与 `docs/superpowers/plans/2026-11-11-subagent-result-delivery.md` 到快照 `docs/` 内
- Create: 无

**Interfaces:** Consumes T1–T5 全部改动路径；Produces 一个基于 `62cd739c` 的远端分支 + PR（不合并）

- [ ] **Step 1: 复制规格与计划进快照**

```bash
cp /Users/4seven/workspace/pi-lnk/docs/superpowers/specs/2026-11-11-subagent-result-delivery-design.md \
   /tmp/pi-lnk-master-62cd739c/docs/superpowers/specs/
cp /Users/4seven/workspace/pi-lnk/docs/superpowers/plans/2026-11-11-subagent-result-delivery.md \
   /tmp/pi-lnk-master-62cd739c/docs/superpowers/plans/
```

- [ ] **Step 2: 全量单测（三包）**

```bash
cd /tmp/pi-lnk-master-62cd739c
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"
env -u NODE_OPTIONS pnpm --filter @lnkpi/server exec vitest run --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS pnpm --filter @lnkpi/web exec vitest run --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS pnpm --filter @pi-lnk/pi-runtime test
```
预期：全 PASS。任何 FAIL 必须定位到具体任务并修，不得跳过或改用 `--exclude`。

- [ ] **Step 3: 类型检查**

```bash
cd /tmp/pi-lnk-master-62cd739c
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"
env -u NODE_OPTIONS pnpm exec vue-tsc -b     # 勿加 --noEmit
cd /tmp/pi-lnk-master-62cd739c/services/pi-runtime && env -u NODE_OPTIONS pnpm exec tsc --noEmit
```
预期：无新增错误。既有基线错误须与未改动快照对比区分（先对原始 tarball 解包跑一次基线，或用 `gh api` 取 master CI 结论对照）。

- [ ] **Step 4: 静态守卫 + 变异自检汇总**

```bash
cd /tmp/pi-lnk-master-62cd739c
# 每个 tool_call 必有配对 tool_result 或显式 turn_interrupted
grep -rEn "tool_call|turn_interrupted" apps/web/src/components/agent/turnTimeline.ts | head -40
# 零 usage 不得 settle credits>0：确认新分支在 quote 之前短路
grep -nE "shouldReleaseHold|Math\.max\(1|quoteTextTokens" apps/server/src/agent/agent.service.ts
# 死代码核对：TRACE_PERSIST_EVENT_TYPES 全仓引用数应仍为 1（只有定义）
grep -rEn "TRACE_PERSIST_EVENT_TYPES" apps packages | wc -l
```
逐项记录实际输出。变异自检至少复跑 T1 Step 4 的顺序变异（必须 RED→GREEN）。

- [ ] **Step 5: REST 推 PR（不合并）**

按项目纪律：
1. `gh api repos/{owner}/{repo}/git/ref/heads/master` 取真实 HEAD；若已前移（`62cd739c` 不再是 master），**先重新核对目标路径 blob 与新 master**：blob 全等 ⇒ 可换 parent/base_tree；blob 不全等 ⇒ 必须基于新 master 重建单 commit，**禁止**仅凭 `MERGEABLE` 下结论（#822 教训）。
2. 逐个改动路径 `gh api .../git/blobs` 建 blob；`POST /git/trees` 时 `base_tree` = 真 master sha 且 `tree` **只列改动路径**。
3. `POST /git/commits` → `POST /git/refs`（新分支 `fix/subagent-turn-interrupted-d1`）→ `POST /pulls`。
4. 推后 `gh api .../compare/master...<branch>` 核验 `DELTA = 改动路径集合` 且 `ALL_PARALLEL_KEPT`（不覆盖并行窗口他人改动）。
5. PR 正文必须**回读长度**（`@文件路径` 会静默丢内容），写入：根因一句话、D1 改动清单、验收命令、No-Go 边界、「未合并未部署，等单独授权」。

- [ ] **Step 6: 停在合并前，回报**

CI 结论以 `gh api` 为准（本机 fetch 不可达）。**不合并、不触发 runtime-deploy、不做生产复测**；等用户单独授权。回报内容：PR 号与 URL、CI 结论、T1–T5 测试结果、变异自检实际输出、静态守卫输出、未闭环项（82 条 truncated 分层归因、真机走查、D2–D7 排期）。

---

## Self-Review（写完计划后对照规格逐项核对）

**1. Spec coverage**

| 规格章节 | 覆盖任务 |
|---|---|
| §5.1 单一判据 + 双适配器 + 判定顺序 | T1（实现）、T2（运行时接线） |
| §5.2 事件契约 / data / 落库 / `[DONE]` 语义 | T2（产出 + `pushTraceEvent`）、T3/T4（消费） |
| §5.3 计费 release（窄判据、不改 `Math.max`） | T2（结算块新分支） |
| §5.4 前端可恢复中断态 / 不改 finalize / notice 文案 / 重试 | T3（模型层）、T4（接线与渲染） |
| §5.5 指标与账本分工（诚实边界） | T5（埋点 + 注释）、T2（账本） |
| §5.6 数据流 | T2→T3→T4 串起来 |
| §6 生产记录 A/B 求值 + 6 组变异 | T1（全部用例，含 M1–M6） |
| §7 兼容性 / 老消息不回填 / 挂起 / shadow | T1（shadow + 挂起）、T2（挂起阴性）、T3（老消息回归） |
| §8 测试矩阵 | T1–T5 + T6 Step 2/3 |
| §9 分刀（只做 D1） | 全局约束 + T6 不合并 |
| §10 No-Go | Global Constraints + 各任务「不改」标注 |
| §11 风险边界 | T6 Step 6 回报 |

无缺口。

**2. Placeholder scan**：全篇无 `TBD` / `TODO` / `implement later` / `add appropriate error handling` / `similar to Task N` / `void` 占位。T2 Step 1 的两个 describe 块均给出完整可执行测试代码（含 `points`/`pricing` 构造桩、阳性/阴性/挂起/计费四组用例），无「照抄某文件」式的空指代。

**3. Type consistency**：`TurnEndSignals` / `TurnEndKind` / `deriveSignalsFromStream` / `deriveSignalsFromRecord` / `outstandingToolCallIds` / `shouldReleaseHold(s, k)` / `shouldEmitInterrupted(k)` 在 T1 定义、T2 消费，签名逐字一致；`'interrupted'` 字面量在 T3 定义、T4 消费；`notice:turn-interrupted` 在 T3 产出、T4 渲染与 T1 静态守卫共用；`reason: 'no_terminal_event'` 在 T2 产出、T3 union 声明、T1 测试断言一致。

**4. Review Focus**：5 类输入全部映射到具体测试 —— ① T1 M6 + 顺序变异；② T1 纯文本断流边界；③ T3 无 callId 恢复；④ T3 幂等 + 重放；⑤ T4 互斥 + 不追加断链文案。无空项。
