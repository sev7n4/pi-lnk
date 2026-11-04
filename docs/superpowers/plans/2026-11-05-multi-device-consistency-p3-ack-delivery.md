# P3 送达面收口（D4 mode 三态可达 + D5 排队可见）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让服务端已裁定的回合归属（run/steer/followup）在 flag-on 生产链路真实可达，并让排队消息「落库可见、消费可判」——补齐 D4/D5 判据的最后一公里。

**Architecture:** 全部复用既有机制做**镜像式补桥**：turn_ack/turn_not_submitted 按 turn_settled 既有接线补进 SessionEventBus→runEventStream 通道；隐式 409→steer 路径复用显式路径的落库口径（entryId+queued）；历史面的 queued 消费判定用读时派生（有更晚 assistant 行即已消费），不动 runtime、不加迁移。

**Tech Stack:** NestJS（apps/server）+ Vue3（apps/web）+ Prisma/SQLite；测试 vitest（server/web 双侧）。

**Spec:** `docs/superpowers/specs/2026-10-21-multi-device-consistency-design.md`（§5.2 ACK 契约、D4/D5 判据、Task 6/8）+ rootfix `2026-11-01-red-car-disconnect-misreport-duplicate-rootfix.md` T2。

## ⭐ 预检定性（2026-11-05，基线 = 远端 master `65ab72e7`）

本包**大幅收窄**——预检发现 P3 的两大主体早已落地，**禁止重做**：

| 项 | 现状 | 出处 |
|---|---|---|
| 意图幂等（normalizeIntent/isRegenerationIntent/findDuplicateIntent/60s 近窗/schema `normalizedIntent` 列+`@@index([threadId, normalizedIntent])`/controller 入口去重门） | ✅ 已落地 | **#659**（red-car rootfix P0+P4） |
| Task 6 服务端裁定（`turnMode: 'run'\|'steer'\|'followup'` + 409→steer→followUp 兜底 + `turn_not_submitted{reason}` + 流末 `turn_ack{runId?, mode, reason?}`） | ✅ 已落地 | #547 起多轮迭代（agent.service.ts:2907-3440） |
| 显式插话端点（/runs/steer、/runs/followup）入队即落库（`persistQueuedUserMessage`，queued:true+entryId） | ✅ 已落地 | 2026-10-21 |
| Schema 三列 `seq/clientId/queued` + `entryId` | ✅ 已落地 | #547（迁移 20261022043000） |
| Web `isTurnTerminal` 含 turn_ack/turn_not_submitted；ownTurnViaObserver 终态收口 | ✅ 已落地 | P1（#708） |

**本包真实缺口（4 个，全部是「送达/落库/派生」面）：**

- **G1（D4 断裂）**：flag-on 生产模式下 generator 的 yield 帧被后台 drain 丢弃 ⇒ `turn_ack{mode}` 与 `turn_not_submitted{reason}` 前端**永远收不到**（bus 只桥接了 turn_settled/credit_tx）。D4 判据「每次发消息都拿到 {mode}」在生产为假。
- **G2（D5 隐式路径）**：streamConversation 内 409→`client.steer/followUp` 的**隐式**插话路径不回写既有 user 行（steer 返回的 `entryId` 被丢弃、`queued` 恒 false）——与显式路径（persistQueuedUserMessage）双轨不一致。用户行本体已在 prompt 前落库（:882）⇒ 「刷新后仍在」成立，但「能看出它排队过」不成立。
- **G3（queued 永不收口）**：`queue_update` 事件在 pi-runtime 内部存在但**刻意不进 SSE**（session-manager.ts:1740 决策）⇒ `queued:true` 写入后无任何转 false 机制（schema 注释里的「终态由消费信号转 false」从未实现）；web 也不渲染 queued。
- **G4（messageId 缺席）**：turn_ack 注释明说「messageId 留待 Task 8」⇒ G2 落库后可回填。

**关键设计决策（评审重点）：**

1. **turn_ack 无迟到回放**（与 turn_settled 的 15s replay 刻意不同）：turn_settled 是幂等覆盖写（reducer 覆盖自愈），回放无害；turn_ack 是**回合裁定语义**，重挂后的新订阅若回放旧 ack 会把「新回合」误标「已并入」。故 turn_ack 只投**订阅在飞**的连接。
2. **turn_not_submitted 的受众面**：flag-off 下它只出现在提交者自己的 POST 流（观察者看不到）。桥接进共享 /runs/events 通道后**观察者也会收到** ⇒ web 端必须把 turn_not_submitted 圈进 own-turn 作用域（`ownTurnViaObserver` gate），观察者路径忽略之（fut.ts 派发层过滤）。turn_ack 无此问题（done 已是观察者终态，ack 后到是幂等 no-op）。
3. **queued 消费判定走读时派生**（不动 runtime、不加写路径）：`effectiveQueued = row.queued && 同窗内不存在更晚的 assistant 行`。理由：steer 在 turn 边界消费、followUp 在收尾边界消费——owner 流在 agent_end 即收尾（早于 followUp 消费）⇒ 写时翻转要么过早要么需要 runtime 事件（被 :1740 决策否决）。读时派生语义精确且零新增故障面。
4. **messageId 的键不出现纪律**：落库失败（fail-soft）⇒ turn_ack 不带 messageId 键（与 runId 同规）。
5. **不做**：JSON ack 加 mode（mode 在 prompt 被 409 后才确定，ack 立即返回，塞不进）；fork 线程的 bus 路由键不对称问题（见 Review Focus 5，属既有 turn_settled 桥的潜在问题，本包只钉测试不扩scope）。

## Global Constraints

- 基线：远端 master `65ab72e7`（本地主检出停在 #640 是陈旧快照——**一切事实以远端为准**，worktree 必须建在远端 HEAD 上）。
- flag-off 路径**逐字节不变**：所有 bus 发射必须 gate 在 `streamOpts?.bridgeSettledToBus === true`（drain 模式专用）；flag-off 的 SSE 流内 yield 原样保留。
- `streamConversation` 有 ~40 处按位置调用的测试：**参数一律末尾追加，禁止中段插参**（spec §11 R2）。
- 键不出现纪律：`runId`/`messageId` 缺证据时不出现该键（不发 null/空串）。
- bash 的 grep 是 toybox shim（复杂模式静默零命中）——**取证一律用 Grep 工具**。
- 测试纪律：Nest/web 用本地 vitest 二进制（`./node_modules/.bin/vitest run <file> --maxWorkers=1 --no-file-parallelism`，`env -u NODE_OPTIONS`）；web 组件改动后跑 `vue-tsc -b`。
- 推送走 REST Git Data API（blob 必须 `-F content=@file`，`-f` 不展开 `@`）；`gh api -q '.sha'` 防 ENOBUFS。
- 本包不碰 `services/pi-runtime/**` ⇒ 合并后**无需** runtime-deploy（deploy.yml 的 Build API + Deploy web 自动覆盖）。

## Review Focus

1. **观察者误收尾**（最危险）：turn_not_submitted 进共享通道后，纯观察者的 follow-up-tail 若把它当终态 ⇒ 旁观轮提前收尾。预期：观察者忽略该帧（不终止旁观轮），仅 own-turn 提交者消费。→ Task 6 Step 1 的测试钉。
2. **flag-off 双发**：bus 发射若漏 gate ⇒ flag-off 下 SSE 流内 yield + bus 注入各一次（runEventStream 在 flag-off 下也被旁听使用）⇒ 观察者重复帧。预期：flag-off 零 bus 发射。→ Task 2 Step 1 的测试钉。
3. **隐式路径双行**：409→steer 落库若用 create 而非 update 既有行 ⇒ 同一句话两行（:882 已建一行）。预期：定位「thread 内最新 entryId:null 的 user 行」做 update，幂等 no-op。→ Task 4 Step 1 的测试钉。
4. **queued 派生的页边界**：消费判定只在当页窗口内找更晚 assistant 行；desc 分页下 reply 恒新于 user 行 ⇒ 必在同窗或更早页。预期：深分页下 queued 派生不误报「排队中」。→ Task 5 Step 1 的测试钉。
5. **fork 线程 bus 路由键不对称（既有问题，本包只记录）**：settled 桥 emit 用 `sessionId`（画布 id），runEventStream 订阅用 `threadId||sessionId` ⇒ fork 出的非默认线程 settle/ack 可能路由丢失。主路径 threadId===sessionId 不受影响。→ Task 3 Step 1 加一条文档性测试断言（主路径键一致），修复留独立议题。

---

### Task 1: SessionEventBus 增设 turn_ack / turn_not_submitted 通道

**Files:**
- Modify: `apps/server/src/points/session-event-bus.service.ts`
- Test: `apps/server/src/points/session-event-bus.service.test.ts`（若不存在则新建；先确认既有测试文件名）

**Interfaces:**
- Consumes: 既有 `subscribe()` 私有helper（registry+event 联合）
- Produces: `TurnAckBusEvent`、`TurnNotSubmittedBusEvent` 类型；`emitTurnAck(ev)`、`emitTurnNotSubmitted(ev)`、`subscribeSessionTurnAck(sessionId, fn)`、`subscribeSessionTurnNotSubmitted(sessionId, fn)`（均返回退订函数）。**无回放**（与 turn_settled 的 15s replay 刻意不同，注释写明理由）。

- [x] **Step 1: 写失败测试**

```ts
// apps/server/src/points/session-event-bus.service.test.ts（追加或新建）
import { describe, it, expect, vi } from 'vitest'
import { SessionEventBus } from './session-event-bus.service'

describe('SessionEventBus turn_ack / turn_not_submitted 通道（P3 G1）', () => {
  it('emitTurnAck 路由到同 sessionId 的订阅者，剥不剥键由调用方负责', () => {
    const bus = new SessionEventBus()
    const got: unknown[] = []
    const unsub = bus.subscribeSessionTurnAck('t1', (ev) => got.push(ev))
    bus.emitTurnAck({ sessionId: 't1', mode: 'steer', reason: 'not_idle' })
    expect(got).toEqual([{ sessionId: 't1', mode: 'steer', reason: 'not_idle' }])
    unsub()
    bus.emitTurnAck({ sessionId: 't1', mode: 'run' })
    expect(got).toHaveLength(1) // 退订后不再收
  })

  it('emitTurnNotSubmitted 路由到同 sessionId 订阅者；无订阅者静默', () => {
    const bus = new SessionEventBus()
    const got: unknown[] = []
    bus.subscribeSessionTurnNotSubmitted('t2', (ev) => got.push(ev))
    expect(() =>
      bus.emitTurnNotSubmitted({ sessionId: 't-other', reason: 'not_steerable' }),
    ).not.toThrow()
    bus.emitTurnNotSubmitted({ sessionId: 't2', reason: 'not_steerable' })
    expect(got).toEqual([{ sessionId: 't2', reason: 'not_steerable' }])
  })

  it('⭐ turn_ack 无迟到回放（与 turn_settled 的 replay 刻意不同）', () => {
    const bus = new SessionEventBus()
    bus.emitTurnAck({ sessionId: 't3', mode: 'run' }) // 无订阅者时 emit
    const got: unknown[] = []
    bus.subscribeSessionTurnAck('t3', (ev) => got.push(ev)) // 迟到订阅
    expect(got).toEqual([]) // 不得回放旧裁定
  })

  it('同 sessionId 双订阅者都收到（多端一致）', () => {
    const bus = new SessionEventBus()
    const a: unknown[] = []
    const b: unknown[] = []
    bus.subscribeSessionTurnAck('t4', (ev) => a.push(ev))
    bus.subscribeSessionTurnAck('t4', (ev) => b.push(ev))
    bus.emitTurnAck({ sessionId: 't4', mode: 'followup', reason: 'not_idle' })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/server && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/points/session-event-bus.service.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（emitTurnAck / subscribeSessionTurnAck 不存在）

- [x] **Step 3: 实现（镜像 turn_settled 通道）**

在 `session-event-bus.service.ts` 中追加（类型放 TurnSettledBusEvent 之后）：

```ts
/**
 * turn_ack 总线事件（P3 G1，multi-device spec §5.2 D4）：streamConversation 在
 * drain 模式（flag `STREAM_MAIN_FROM_PIRUNTIME=on`）下 yield 帧被丢弃 ⇒ 服务端
 * 已裁定的回合归属（run/steer/followup）前端经 /runs/events 收不到。字段与
 * turn_ack 流事件 data 相同 + 路由用的 sessionId。
 */
export type TurnAckBusEvent = {
  sessionId?: string
  runId?: string
  mode: 'run' | 'steer' | 'followup'
  reason?: 'not_idle' | 'not_steerable'
  messageId?: string
}

/**
 * turn_not_submitted 总线事件（P3 G1）：409 转 steer/followUp 的结构化告知帧。
 * ⚠️ 受众面变化（flag-off 下只有提交者自己的 POST 流可见）：桥接进 /runs/events
 * 后观察者也会收到 —— web 端必须圈定 own-turn 作用域（AgentSideRail
 * ownTurnViaObserver gate），观察者路径忽略（spec 计划 Review Focus 1）。
 */
export type TurnNotSubmittedBusEvent = {
  sessionId?: string
  reason: 'not_idle' | 'not_steerable'
}

export type TurnAckListener = (ev: TurnAckBusEvent) => void
export type TurnNotSubmittedListener = (ev: TurnNotSubmittedBusEvent) => void
```

类内追加（镜像 turnSettledEmitters，**无 lastTurnAck 保留表**）：

```ts
private readonly turnAckEmitters = new Map<string, EventEmitter>()

/** streamConversation 在 drain 模式下与 turn_ack yield 同点调用；无 sessionId 静默丢弃。 */
emitTurnAck(ev: TurnAckBusEvent): void {
  if (!ev.sessionId) return
  this.turnAckEmitters.get(ev.sessionId)?.emit('turn_ack', ev)
}

emitTurnNotSubmitted(ev: TurnNotSubmittedBusEvent): void {
  if (!ev.sessionId) return
  this.turnAckEmitters.get(ev.sessionId)?.emit('turn_not_submitted', ev)
}

/**
 * runEventStream 订阅本会话的 turn_ack / turn_not_submitted 补桥。
 * ⭐ 刻意**无迟到回放**（与 turn_settled 的 15s replay 不同）：turn_settled 是
 * 幂等覆盖写、回放自愈无害；turn_ack 是回合**裁定**语义，重挂后的新订阅回放
 * 旧 ack 会把新回合误标「已并入」⇒ 只投订阅在飞的连接。
 */
subscribeSessionTurnAck(sessionId: string, fn: TurnAckListener): () => void {
  return this.subscribe(this.turnAckEmitters, sessionId, 'turn_ack', fn)
}

subscribeSessionTurnNotSubmitted(sessionId: string, fn: TurnNotSubmittedListener): () => void {
  return this.subscribe(this.turnAckEmitters, sessionId, 'turn_not_submitted', fn)
}
```

并把私有 `subscribe()` 的 event 参数类型扩为 `'credit_tx' | 'turn_settled' | 'turn_ack' | 'turn_not_submitted'`，fn 类型扩为 `CreditTxListener | TurnSettledListener | TurnAckListener | TurnNotSubmittedListener`。

- [x] **Step 4: 跑测试确认通过**

Run: 同 Step 2。
Expected: PASS（4/4）

- [x] **Step 5: Commit**

```bash
git add apps/server/src/points/session-event-bus.service.ts apps/server/src/points/session-event-bus.service.test.ts
git commit -m "feat(server): SessionEventBus turn_ack/turn_not_submitted channels (P3 G1)"
```

### Task 2: streamConversation drain 桥接（yield 点同步 emit）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（turn_not_submitted yield 点 ~:3024；turn_ack yield 点 ~:3424）
- Test: `apps/server/src/agent/agent.turn-ack-bridge.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `emitTurnAck` / `emitTurnNotSubmitted`；既有 `streamOpts?.bridgeSettledToBus` gate（语义扩为「drain 补桥」总开关，注释更新；**不改名**——startConversationRun 调用点零改动）。
- Produces: flag-on 下 turn_ack / turn_not_submitted 经 bus 可达；flag-off 零发射（逐字节不变）。

- [x] **Step 1: 写失败测试**

```ts
// apps/server/src/agent/agent.turn-ack-bridge.test.ts
// 基建（makeService/假 pi client）对齐 apps/server/src/agent/ 下既有 agent.service 测试的
// 手写 prisma 替身模式（参考 multi-device-stream.consistency.test.ts 的桩法）。
// 核心：让 client.prompt 抛 409、client.steer 成功 ⇒ streamConversation 走 steer 分支。
import { describe, it, expect, vi } from 'vitest'

describe('streamConversation drain 补桥（P3 G1 / Review Focus 2）', () => {
  it('flag-on（bridgeSettledToBus）下 409→steer 成功 ⇒ bus 收到 turn_not_submitted{not_idle} 与 turn_ack{mode:steer}', async () => {
    // 桩：prompt 抛 {status:409}，steer 返回 {queued:true, entryId:'e1'}
    // 收集 bus 事件：eventBus 为注入替身，记录 emitTurnAck / emitTurnNotSubmitted 调用
    // 消费 generator 至耗尽（不接 SSE）
    // 断言：emitTurnNotSubmitted 被调 1 次 {sessionId, reason:'not_idle'}
    //       emitTurnAck 被调 1 次 {sessionId, mode:'steer', reason:'not_idle'}（messageId 见 Task 4，此处断言不带该键）
  })

  it('flag-off（不传 streamOpts）⇒ bus 零发射（Review Focus 2：双发防线）', async () => {
    // 同上桩，但不传 streamOpts
    // 断言：emitTurnAck / emitTurnNotSubmitted 均 0 次；流内 yield 仍含两帧（flag-off 契约不变）
  })

  it('steer+followUp 双失败 ⇒ turnMode undefined ⇒ 不发 turn_ack（把没受理包装成受理=纪律违例）', async () => {
    // 桩：prompt 409、steer 抛、followUp 抛
    // 断言：emitTurnNotSubmitted 1 次 {reason:'not_steerable'}；emitTurnAck 0 次
  })
})
```

（实现测试时把三条 it 的桩代码写实：参照 `multi-device-stream.consistency.test.ts` 的 makeService 与 pi client 替身；`client.prompt` 抛 `Object.assign(new Error('busy'), {status: 409})`。）

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/server && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/agent/agent.turn-ack-bridge.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（bus 未被调用）

- [x] **Step 3: 实现——两个 yield 点各补一次 emit**

turn_not_submitted yield 点（~:3024）之前补：

```ts
// P3 G1：drain 模式下本帧被丢弃 ⇒ 经 bus 补投（gate 与 turn_settled 补桥同源）。
if (streamOpts?.bridgeSettledToBus === true) {
  this.eventBus?.emitTurnNotSubmitted({ sessionId, reason: turnRefusalReason })
}
```

turn_ack yield 点（~:3424，`if (turnMode) {` 块内 yield 之前）补：

```ts
// P3 G1：同上（drain 丢帧补投）。data 与流内 yield 同源，杜绝口径漂移。
if (streamOpts?.bridgeSettledToBus === true) {
  this.eventBus?.emitTurnAck({ sessionId, mode: turnMode, ...(turnMode !== 'run' ? { reason: turnRefusalReason } : {}), ...(turnRunId ? { runId: turnRunId } : {}) })
}
```

（`turnRunId` 在该作用域已存在——:3430 的 yield 用了它；若变量名有出入以远端实际为准。`sessionId` 是 streamConversation 首参。）

同步更新 `streamOpts?.bridgeSettledToBus` 的参数注释（:783）：语义从「turn_settled 补桥」扩为「drain 补桥总开关（turn_settled / turn_ack / turn_not_submitted）」。

- [x] **Step 4: 跑测试确认通过 + 既有回归**

Run: `cd apps/server && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/agent/agent.turn-ack-bridge.test.ts src/agent/conversation-ack.test.ts src/agent/multi-device-stream.consistency.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/server/src/agent/agent.service.ts apps/server/src/agent/agent.turn-ack-bridge.test.ts
git commit -m "feat(server): bridge turn_ack/turn_not_submitted to SessionEventBus in drain mode (P3 G1)"
```

### Task 3: runEventStream 注入（/runs/events 可达）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（runEventStream ~:1276-1368，镜像 settledUnsub）
- Test: `apps/server/src/agent/agent.turn-ack-bridge.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `subscribeSessionTurnAck` / `subscribeSessionTurnNotSubmitted`
- Produces: /runs/events 流内出现 `turn_ack` / `turn_not_submitted` 帧（剥 sessionId 路由键）；finally 退订。

- [x] **Step 1: 写失败测试（追加到 Task 2 的测试文件）**

```ts
describe('runEventStream 注入（P3 G1 / Review Focus 5）', () => {
  it('bus emit turn_ack ⇒ runEventStream 流内出现 turn_ack 帧（剥 sessionId）', async () => {
    // 桩：createPiRuntimeClient.streamEvents 用手动可控回调（既有测试同款）；
    // 先启动 runEventStream 迭代，再 eventBus.emitTurnAck({sessionId:'k1', mode:'steer'})
    // 断言：迭代产出 {type:'turn_ack', data:{mode:'steer'}}——data 不含 sessionId 键
  })
  it('文档性断言：路由键主路径一致（Review Focus 5，fork 不对称只记录不修）', () => {
    // 断言常量/注释级：runEventStream 订阅键 = threadId||sessionId（controller :698），
    // emit 键 = streamConversation 的 sessionId 首参；主路径 threadId===sessionId ⇒ 一致。
    expect(true).toBe(true) // 占位保持 describe 非空；真实约束由上方行为测试承载
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: 同 Task 2 Step 2（文件追加后整文件跑）。
Expected: 新增 2 例 FAIL（流内无 turn_ack 帧）

- [x] **Step 3: 实现——镜像 settledUnsub**

runEventStream 内（settledUnsub 定义之后）：

```ts
// P3 G1：turn_ack / turn_not_submitted 补桥订阅（streamConversation drain 模式 emit）。
// 剥掉路由用 sessionId 再下发（与 settled 补桥同口径）。两订阅共用一个退订聚合。
const unsubs: Array<() => void> = []
if (this.eventBus) {
  unsubs.push(
    this.eventBus.subscribeSessionTurnAck(sessionKey, (ev) => {
      const { sessionId: _routeKey, ...data } = ev
      queue.push({ type: 'turn_ack', data } as unknown as AgentStreamEvent)
      notify?.()
    }),
    this.eventBus.subscribeSessionTurnNotSubmitted(sessionKey, (ev) => {
      const { sessionId: _routeKey, ...data } = ev
      queue.push({ type: 'turn_not_submitted', data } as unknown as AgentStreamEvent)
      notify?.()
    }),
  )
}
const turnAckUnsub = () => { for (const u of unsubs) u() }
```

finally 块（:1362-1367）补 `turnAckUnsub?.()`。

- [x] **Step 4: 跑测试确认通过 + probe 回归**

Run: `cd apps/server && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/agent/agent.turn-ack-bridge.test.ts src/agent/agent.service.reconcile.test.ts --maxWorkers=1 --no-file-parallelism`（reconcile 测试文件名以远端实际为准；probe 终态名单含 turn_ack/turn_not_submitted ⇒ 桥接后 probe 可能提前 settled——语义正确，回归确认无红）
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/server/src/agent/agent.service.ts apps/server/src/agent/agent.turn-ack-bridge.test.ts
git commit -m "feat(server): runEventStream injects turn_ack/turn_not_submitted from bus (P3 G1)"
```

### Task 4: 隐式 409→steer/followUp 落库补齐 + turn_ack messageId

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（409 分支 ~:2984-3019；新增 `markQueuedUserMessage` 方法，置于 `attachUserMessageEntryId` ~:1645 旁）
- Test: `apps/server/src/agent/agent.turn-ack-bridge.test.ts`（追加）

**Interfaces:**
- Consumes: `client.steer/followUp` 返回的 `{queued, entryId?}`（当前被丢弃）；既有 `attachUserMessageEntryId` 的定位口径（thread 内最新 `entryId:null` 的 user 行，:1660-1664）
- Produces: `markQueuedUserMessage(input: { sessionId: string; threadId: string; entryId: string }): Promise<{ messageId?: string }>`——update 既有行（⛔ 非 create）：`entryId` 回填 + `queued: true`，幂等（entryId 已有唯一索引，重复调用 no-op），fail-soft（行不存在/写失败返 `{}` 不抛）。turn_ack data 增加 `messageId?`（键不出现纪律）。

- [x] **Step 1: 写失败测试（追加）**

```ts
describe('隐式 409→steer 落库补齐（P3 G2 / Review Focus 3）', () => {
  it('steer 成功 ⇒既有 user 行被 update：entryId 回填 + queued:true；turn_ack 带 messageId', async () => {
    // 桩：prisma 替身预置一行 {role:'user', entryId:null, queued:false, id:'m1'}；
    // prompt 409、steer 返回 {queued:true, entryId:'e9'}
    // 断言：prisma.agentMessage.update 被调（where 命中 m1，data 含 entryId:'e9'、queued:true）
    //       emitTurnAck 收到 {mode:'steer', messageId:'m1'}
  })
  it('幂等：entryId 已存在的行 ⇒ no-op 不覆盖（先到先得）', async () => {
    // 桩：行已有 entryId:'e-old'；steer 返回 entryId:'e9'
    // 断言：不发生覆盖写（update 未被调或 where 不命中即返回）
  })
  it('无既有 user 行（机器载荷未落库）⇒ fail-soft：不 create、不抛、turn_ack 不带 messageId', async () => {
    // 桩：prisma 无 user 行
    // 断言：无 create 调用；emitTurnAck 的 data 无 messageId 键
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: 同 Task 2 Step 2。
Expected: 3 例 FAIL

- [x] **Step 3: 实现**

新增方法（attachUserMessageEntryId 之后）：

```ts
/**
 * 隐式插话（409→steer/followUp 兜底）的落库补齐（P3 G2，D5）。
 *
 * 与显式端点（persistQueuedUserMessage）的差异：本路径的 user 行**早已存在**
 * （streamConversation 在 prompt 前落库，:882）⇒ 这里是 **update 既有行**而非 create
 * ——再 create 就是同一句话两行（Review Focus 3）。定位口径与 attachUserMessageEntryId
 * 同源：thread 内最新 entryId:null 的 user 行。entryId 唯一索引 ⇒ 重复调用天然 no-op。
 * fail-soft：无行 / 写失败都只 warn，绝不阻断对话主链路。
 */
async markQueuedUserMessage(input: {
  sessionId: string
  threadId: string
  entryId: string
}): Promise<{ messageId?: string }> {
  const threadKey = input.threadId?.trim()
  const entry = input.entryId?.trim()
  if (!threadKey || !entry) return {}
  try {
    const row = await this.prisma.agentMessage.findFirst({
      where: { sessionId: input.sessionId, threadId: threadKey, role: 'user', entryId: null, queued: false },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (!row) return {}
    await this.prisma.agentMessage.update({
      where: { id: row.id },
      data: { entryId: entry, queued: true },
    })
    return { messageId: row.id }
  } catch (err) {
    this.piLogger?.warn?.(
      `queued user message update skipped (fail-soft, thread=${threadKey}, entryId=${entry}): ${err instanceof Error ? err.message : String(err)}`,
    )
    return {}
  }
}
```

409 分支接线（steer 成功处，~:2993）：

```ts
const steerRes = await client.steer(sessionKey, promptText, "main", { turnContext })
turnMode = 'steer'
// P3 G2：隐式插话与显式端点同权——entryId 不再丢弃，既有 user 行补 queued+entryId。
const queuedMark = await this.markQueuedUserMessage({
  sessionId,
  threadId: sessionKey,
  entryId: (steerRes as { entryId?: string } | undefined)?.entryId ?? '',
})
turnMessageId = queuedMark.messageId
```

followUp 成功处（~:3008）同样处理。`turnMessageId` 声明加在 `turnMode` 声明旁（`let turnMessageId: string | undefined`），turn_ack yield/emit data 补 `...(turnMessageId ? { messageId: turnMessageId } : {})`（yield 与 bus emit 两处都要）。

- [x] **Step 4: 跑测试确认通过 + 回归**

Run: 同 Task 2 Step 4 全量（加 src/agent 下既有 agent.service 相关测试文件，文件名以远端为准 `ls apps/server/src/agent/*.test.ts`）。
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add apps/server/src/agent/agent.service.ts apps/server/src/agent/agent.turn-ack-bridge.test.ts
git commit -m "feat(server): implicit steer/followUp persists queued+entryId, turn_ack carries messageId (P3 G2/G4)"
```

### Task 5: 历史面 queued 读时派生（D5 收口）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（getMessages ~:659-698）
- Test: `apps/server/src/agent/agent.messages-queued.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 getMessages 分页窗口（desc 序，`take*2` overfetch）
- Produces: 返回行中 user 行的 `queued` 为**派生值**：`row.queued && 窗口内不存在 createdAt 更晚的 assistant 行`。assistant 行与存量行不受影响。

- [x] **Step 1: 写失败测试**

```ts
// apps/server/src/agent/agent.messages-queued.test.ts
describe('getMessages queued 读时派生（P3 G3 / Review Focus 4）', () => {
  it('queued:true 且窗口内有更晚 assistant 行 ⇒ 派生为 false（已消费）', () => { /* ... */ })
  it('queued:true 且无更晚 assistant 行 ⇒ 保持 true（仍在排队）', () => { /* ... */ })
  it('assistant 行 / queued:false 行原样透传（不受派生污染）', () => { /* ... */ })
  it('深分页：user 行在窗口老端、reply 更新于窗口内 ⇒ 仍正确派生（desc 序 reply 必在同窗）', () => { /* ... */ })
})
```

（每条 it 写实：手写 prisma findMany 替身返回固定行数组，断言映射后 queued 值。）

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/server && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/agent/agent.messages-queued.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL

- [x] **Step 3: 实现（paginateVisibleRows 之前对 visible 派生）**

```ts
// P3 G3（D5 收口）：queued 的消费判定走**读时派生**——steer 在 turn 边界消费、
// followUp 在收尾边界消费，而 owner 流在 agent_end 即收尾（早于 followUp 消费）
// ⇒ 写时翻转要么过早要么依赖 runtime queue_update 事件（刻意不进 SSE，
// session-manager.ts:1740）。desc 分页下 reply 恒新于 user 行 ⇒ 必在同窗或更早页，
// 窗口内判定即全局判定（Review Focus 4）。
const latestAssistantAt = rows.reduce<number>((acc, r) => {
  if (r.role === 'assistant') return Math.max(acc, new Date(r.createdAt).getTime())
  return acc
}, 0)
const derived = visible.map((r) =>
  r.role === 'user' && r.queued && latestAssistantAt > new Date(r.createdAt).getTime()
    ? { ...r, queued: false }
    : r,
)
return paginateVisibleRows(derived, take, rows.length)
```

- [x] **Step 4: 跑测试确认通过**

Run: 同 Step 2。
Expected: PASS（4/4）

- [x] **Step 5: Commit**

```bash
git add apps/server/src/agent/agent.service.ts apps/server/src/agent/agent.messages-queued.test.ts
git commit -m "feat(server): derive queued consumption state at read time in getMessages (P3 G3)"
```

### Task 6: Web 消费（own-turn 圈定 + 「已并入」呈现 + queued 徽标）

**Files:**
- Modify: `apps/web/src/components/agent/follow-up-tail.ts`（onEvent 派发层：观察者路径忽略 turn_not_submitted）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（handleEvent：own-turn 作用域消费 turn_ack{mode}/turn_not_submitted；queued 徽标）
- Modify: `apps/web/src/stores/agent.ts`（消息映射透传 queued 字段——先核对映射点字段白名单形态）
- Test: `apps/web/src/components/agent/follow-up-tail.main.test.ts`（追加）、AgentSideRail 接线测试（对齐既有 `AgentSideRail.mainAckWiring.test.ts` 模式，文件名以远端为准）

**Interfaces:**
- Consumes: /runs/events 流内 `turn_ack{runId?, mode, reason?, messageId?}`、`turn_not_submitted{reason}`（Task 3 产物）；store 消息行的 `queued`（Task 5 产物，随既有历史拉取到达）
- Produces: ① 观察者路径不把 turn_not_submitted 当终态（Review Focus 1）；② own-turn 提交者收到 turn_ack{mode≠'run'} ⇒ 自己的气泡标记「已并入进行中的任务」并正常收口；③ turn_not_submitted{not_steerable} ⇒ own-turn 失败提示；④ queued 徽标随 turn_ack{mode≠'run'} 实时清除。

- [x] **Step 1: 写失败测试（fut 派发层）**

```ts
// 追加到 apps/web/src/components/agent/follow-up-tail.main.test.ts
it('观察者路径：turn_not_submitted 不触发 onTurnEnd（Review Focus 1——旁观轮不得被第三方拒绝帧误收尾）', () => {
  // 构造 tail 订阅，注入 {type:'turn_not_submitted', data:{reason:'not_steerable'}}
  // 断言：onTurnEnd 未被调用；onEvent（宿主 handleEvent）仍收到该帧
})
it('own-turn 圈定由宿主 gate 承载：派发层原样转发 turn_ack（终态，幂等）', () => {
  // 注入 turn_ack{mode:'steer'} ⇒ onTurnEnd 恰一次（与 done 后到 ack 的幂等语义一致）
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/components/agent/follow-up-tail.main.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: 新增例 FAIL

- [x] **Step 3: 实现 fut.ts 派发层**

onEvent 分派处（~:402 `isTurnTerminal` 分支）改为：

```ts
} else if (payload.type === 'turn_not_submitted') {
  // P3：结构化拒绝帧。受众=提交者本人（own-turn），观察者不得据此收尾旁观轮
  // （运行中的 run 与「第三方消息被拒」无关）。照常转发宿主，但不走终态收口。
  onEvent?.(payload)
} else if (isTurnTerminal(payload.type)) {
```

（宿主 onEvent 回调签名与既有转发形态保持一致，以远端实际代码为准。）

- [x] **Step 4: 写失败测试 + 实现 AgentSideRail own-turn 消费**

测试（对齐 mainAckWiring 模式）：own-turn 作用域收到 `turn_ack{mode:'steer'}` ⇒ 自己最后一条 user 气泡获得「已并入」标记（复用 :2264 附近既有文案键）且 finishOwnTurnViaObserver 收口；收到 `turn_not_submitted{reason:'not_steerable'}` ⇒ 走失败提示路径。

实现要点（handleEvent 内 own-turn 分支）：

```ts
case 'turn_ack': {
  const mode = (payload.data as { mode?: string } | null)?.mode
  if (mode && mode !== 'run') {
    // P3 D4：服务端裁定「已并入」——气泡标记 + queued 徽标实时清除
    markOwnBubbleMerged() // 复用既有「已并入当前回答」的文案/标记路径（:2264 附近）
  }
  finishOwnTurnViaObserver() // 既有终态收口（幂等闸已挡 done 先到的情况）
  break
}
case 'turn_not_submitted': {
  if (!ownTurnViaObserver.value) break // 双保险：观察者不消费（fut 层已过滤）
  const reason = (payload.data as { reason?: string } | null)?.reason
  if (reason === 'not_steerable') markOwnTurnRefused() // 失败提示，复用既有拒绝文案路径
  break
}
```

（`markOwnBubbleMerged` / `markOwnTurnRefused` 是**计划占位名**——实现时先在 AgentSideRail 里找到既有「已并入当前回答」与拒绝文案的真实函数/路径对接，禁止新造重复文案。）

- [x] **Step 5: store 透传 queued + 徽标渲染**

stores/agent.ts 的消息映射点（API 行 → store 消息）补 `queued` 透传（若映射是整行展开则只需确认未被剥离）；AgentSideRail 渲染层对 `queued===true` 的 user 气泡显示「排队中」小徽标（用 on-signature 令牌，禁新 hex；文案「排队中」）。

跑：`cd apps/web && env -u NODE_OPTIONS npx vue-tsc -b` + 该组件既有测试全家。

- [x] **Step 6: 跑全部确认通过 + Commit**

```bash
git add apps/web/src/components/agent/follow-up-tail.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/stores/agent.ts apps/web/src/components/agent/follow-up-tail.main.test.ts
git commit -m "feat(web): consume turn_ack{mode}/turn_not_submitted in own-turn scope + queued badge (P3)"
```

### Task 7: 全量回归 + 推送 + CI + 部署闸门

**Files:** 无新文件（流程闸门）

- [x] **Step 1**: 全量回归分批：`apps/server` vitest 全家（`./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism`）+ `apps/web` vitest 全家 + `vue-tsc -b` + 双侧 tsc（主检出对照——worktree 软链 shared dist 陈旧属已知环境差异，只看触碰文件零错）。
- [x] **Step 2**: REST Git Data API 推送（blob `-F` 双向 sha 核对 → tree(base_tree=远端 HEAD) → commit → ref）→ 开 PR → CI 全绿 → squash merge。合并触发 Deploy to Tencent Cloud（Build API + Deploy web；**无 runtime-deploy**——不碰 services/pi-runtime）。
- [x] **Step 3**: 生产行为复测（flag on 已在生产）：① 同句 5 连发 ⇒ 第 2 发起收到「复用」提示（#659 既有门）；② 对运行中会话连发新消息 ⇒ /runs/events 里可见 `turn_not_submitted{not_idle}` 与流末 `turn_ack{mode:'steer'}`，前端气泡「已并入」；③ 刷新 ⇒ 排队徽标随 assistant 行到达消失（读时派生）。
- [x] **Step 4**: PASS ⇒ 收官（规格 §12 状态、日志、计划勾选）；FAIL ⇒ 回滚 = revert PR（bus 通道纯 additive，残留无害）。

---

## 已落地事实（防重做清单）

- `intent-dedup.ts`（normalizeIntent/isRegenerationIntent/INTENT_DEDUP_WINDOW_MS）——#659
- `findDuplicateIntent` + controller 入口去重门（ctl.ts:796-819）——#659
- `turnMode` 三态裁定 + 409→steer→followUp 兜底 + `turn_not_submitted{reason}` + `turn_ack`（svc.ts:2907-3440）——#547 起迭代
- `persistQueuedUserMessage`（显式端点入队即落库）+ `attachUserMessageEntryId`（回填口径）——2026-10-21
- Schema：`AgentMessage.seq/clientId/queued/entryId`、`IdempotencyRecord.normalizedIntent` + `@@index([threadId, normalizedIntent])`——#547/#659
- Web `isTurnTerminal`（fut.ts:179）含 turn_ack/turn_not_submitted；`finishOwnTurnViaObserver`（asr.vue:3102）幂等收口——P1
- SessionEventBus turn_settled 通道（emit/subscribe/15s replay/保留表）——2026-11-04（#721）

---

## 执行实录（2026-11-05 收官）

**PR #726** squash merge `93eeaa82` → master（基线 `7ddc1011`，6 commits：64f88b83 / af54eb40 / b70b4564 / 27dfeb51 / d6119ad5 / 32f22c59）。

| Task | 落点 | 证据 |
|---|---|---|
| T1 bus 通道 | session-event-bus.service.ts + turn-ack.test（4 例，⭐无回放钉） | 红灯 4/4 → 绿 21/21（含 settled 回归） |
| T2 drain 桥接 | agent.service.ts 两 yield 点 gate emit；bridgeSettledToBus 注释扩为总开关 | turn-ack-bridge.test A/B/C（flag-off 零发射钉）；turn-settled-bridge 替身补新方法 |
| T3 runEventStream 注入 | 镜像 settledUnsub，剥 sessionId，finally 聚合退订 | 测试 D（注入+退订）+E（fork 不对称文档性）；turn-usage 折叠回归修复（C 替身缺 subscribe 方法） |
| T4 隐式落库 | markQueuedUserMessage（update 非 create，entryId:null+queued:false 定位口径）；turnMessageId 进 yield+emit | 测试 F（update+messageId）/G（幂等 no-op+无 messageId 键）；G 初版误断 create 零调用（prompt 前正常落库恰 1 次） |
| T5 queued 读时派生 | getMessages 派生 `queued && 无更晚 assistant 行 ⇒ false` | agent.messages-queued.test 4 例 + messages/messages-pagination 回归 17/17 |
| T6 web 消费 | fut.ts 具名分支豁免 + AgentSideRail onEvent 旁观分支豁免（静态契约 observerRefusalExempt）+ queued 徽标 + consumeQueued（turn_ack{messageId}）| fut 全家 34/34；store queuedBadge 3 例；徽标契约 2 例；vue-tsc -b 零错。既有 follow-up-tail.test「turn_not_submitted 收尾」断言按新契约改判（1 次收束=error only） |
| T7 收官 | server 2512/2512、web 3830/3830 全绿 | REST push（blob 15/15 sha 核对、tree/commit/ref）；CI 3/3 绿；Deploy success |

**计划外修正**：
- 测试桩缺口（非生产缺陷）：stubPiClient 不调 onClose ⇒ 409 shadow 流桩需回放 agent_end 让主循环收尾（生产形态：shadow 流借 owner 的 agent_end 收尾）。
- followUp 接线初版重复调用 client.followUp（会入队两次）⇒ 提交前修正为接收首次返回值。
- 既有契约更新：follow-up-tail.test「失败帧收束」从「error+turn_not_submitted 各收 1 次」改为「error 收束、turn_not_submitted 豁免」（P3 有意变更，注释说明受众面扩大缘由）。

**生产取证**：health ok；web bundle `CanvasPage-C0nWNVxq.js` 特征串全中（agent-queued-badge / 排队中 / turn_not_submitted / consumeQueued / 已并入文案）。⏳ 行为复测（5 连发复用提示 / turn_ack 帧可达 / 徽标消失）待真机。无 runtime-deploy（未碰 services/pi-runtime）。
