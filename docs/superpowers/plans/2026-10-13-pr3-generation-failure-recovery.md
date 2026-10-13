# PR3 生成失败 Agent 回注（端到端闭环）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** canvas 视频/图片生成失败后，宿主把结构化失败事件回注对话（活跃 run 走 followUp 尾随、空闲且用户在线走 system-origin 新 turn、离线 skip），失败不再静默红点，端到端交付闭环。

**Architecture:** Nest 新服务 `GenerationRecoveryService`：发射点接 `video-generation.orchestrator.ts` 的两处失败终态（poll terminal failed/error + catch，两处都持有 `{ sessionId, nodeId, generationRecordId }`）；纯决策函数 `decideRecoveryDispatch` 输出 followUp/newTurn/skip；副作用薄壳调既有 `followUpPiRun` / conversation 入口；在线态用 `runs/events` 的 `lastSeenAt` 5 分钟窗口代理；限流三规则（recordId 幂等 / 2 次每小时 / 同因连败降级）；feature flag 灰度。

**Tech Stack:** NestJS、Prisma、vitest（server 包测试 runner 以同目录 *.test.ts 现状为准）

**Spec:** `docs/superpowers/specs/2026-10-13-generation-failure-recovery-and-motion-prompt-design.md` §6

## Global Constraints

- **不新建对话通道**：只调既有 `followUpPiRun`（`agent.service.ts:608`）与 conversation 入口；pi-runtime 零改动。
- **禁自动重试生成**：回注消息文案明示「不要调用 run_*，等待用户选择」；gate fail-closed 是兜底。
- **followUp 是纯透传**（不走 Nest prompt 管线）：回注消息不得要求任何 canvas 写操作（§6.0-2 tradeoff）。
- 在线代理：`runs/events` handler 记 `lastSeenAt`（Session 维度），5 分钟窗口 = 在线；**不得**虚构「SSE 连接存活」判据（F14）。
- feature flag `generation_recovery_enabled` 默认 off；off 时行为与今天逐字节一致（回滚 = 环境变量一行）。
- **先核 `chat/conversation` DTO 是否手工维护字段白名单（F16 遗留项）**：已核实——`agent.controller.ts:531-536` 的 conversation 路由**无 `@UsePipes(ValidationPipe)`** 且无全局 pipe，DTO 装饰器惰性 ⇒ 加字段不会被 400。但本方案最终**不加 origin 字段**（origin 判定走消息文本前缀，Task 5），此项仅作背景事实保留。

## Review Focus

- 发射点竞态：poll 读到 failed 与 catch 抛错**可能同一次调用都触发**（先 poll 失败后 persist 又抛）⇒ 同一 recordId 的去重必须在 service 入口，不能只在两个发射点各去重。
- 用户正在连续插话（steer 积压）时 followUp 被竞争延后（§6.0-3）⇒ 延后不是丢失，遥测要能区分 `dispatched` 与 `deferred`。
- 失败节点所属会话与「当前活跃 thread」不一致（用户已开新任务线）⇒ threadKey 解析回落 sessionId 的语义要有测试钉住。
- 限流计数器的进程重启：放内存会重启丢限流 ⇒ 首版接受（限流是软保护非硬保证），但遥测必须可见。
- reaper 标记的 failed（卡死回收）**不在本期发射范围**（无 canvas session scope），显式排除而非静默遗漏。

---

### Task 1: 决策纯函数 + 单测

**Files:**
- Create: `apps/server/src/agent/generation-recovery/recovery-dispatch.decider.ts`
- Test: `apps/server/src/agent/generation-recovery/recovery-dispatch.decider.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type DispatchPath = 'followUp' | 'newTurn' | 'skip'`
  - `interface DispatchInput { hasActiveRun: boolean; userOnline: boolean; recordIdDispatchedBefore: boolean; sessionDispatchCountLastHour: number; sameCodeStreak: number }`
  - `interface DispatchDecision { path: DispatchPath; reason: string; briefOnly: boolean }`
  - `decideRecoveryDispatch(input: DispatchInput): DispatchDecision`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/agent/generation-recovery/recovery-dispatch.decider.test.ts
import { describe, it, expect } from 'vitest'
import { decideRecoveryDispatch, type DispatchInput } from './recovery-dispatch.decider'

const base: DispatchInput = {
  hasActiveRun: false,
  userOnline: true,
  recordIdDispatchedBefore: false,
  sessionDispatchCountLastHour: 0,
  sameCodeStreak: 1,
}

describe('decideRecoveryDispatch', () => {
  it('空闲 + 在线 + 未超限 → newTurn', () => {
    const d = decideRecoveryDispatch(base)
    expect(d.path).toBe('newTurn')
  })
  it('活跃 run + 在线 → followUp（尾随不打断）', () => {
    const d = decideRecoveryDispatch({ ...base, hasActiveRun: true })
    expect(d.path).toBe('followUp')
  })
  it('离线 → skip（PR1 失败入口兜底）', () => {
    const d = decideRecoveryDispatch({ ...base, userOnline: false })
    expect(d.path).toBe('skip')
  })
  it('同 record 已派发过 → skip（幂等）', () => {
    const d = decideRecoveryDispatch({ ...base, recordIdDispatchedBefore: true })
    expect(d.path).toBe('skip')
  })
  it('session 每小时已 2 次 → skip', () => {
    const d = decideRecoveryDispatch({ ...base, sessionDispatchCountLastHour: 2 })
    expect(d.path).toBe('skip')
  })
  it('同因连败第 2 次（streak=2）→ followUp 且 briefOnly', () => {
    const d = decideRecoveryDispatch({ ...base, hasActiveRun: true, sameCodeStreak: 2 })
    expect(d.path).toBe('followUp')
    expect(d.briefOnly).toBe(true)
  })
  it('离线但同因连败 → 仍 skip（不因降级而破在线门）', () => {
    const d = decideRecoveryDispatch({ ...base, userOnline: false, sameCodeStreak: 2 })
    expect(d.path).toBe('skip')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && ../../node_modules/.bin/vitest run src/agent/generation-recovery/recovery-dispatch.decider.test.ts 2>&1 | tail -5`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写最小实现**

```ts
// apps/server/src/agent/generation-recovery/recovery-dispatch.decider.ts
export type DispatchPath = 'followUp' | 'newTurn' | 'skip'

export interface DispatchInput {
  /** 该会话当前有活跃 run（Nest 侧会话状态）。 */
  hasActiveRun: boolean
  /** 在线代理判据：runs/events lastSeenAt 在 5 分钟窗口内（spec §6.0-1）。 */
  userOnline: boolean
  /** 同一 generationRecordId 是否已派发过（幂等键，防 poll+catch 双发射）。 */
  recordIdDispatchedBefore: boolean
  /** 该 session 最近一小时已派发次数。 */
  sessionDispatchCountLastHour: number
  /** 同一 nodeId 连续同 errorCode 失败次数（1=首次）。 */
  sameCodeStreak: number
}

export interface DispatchDecision {
  path: DispatchPath
  reason: string
  /** true = 同因连败降级：只发一句话简报，不展开选项。 */
  briefOnly: boolean
}

const MAX_PER_SESSION_PER_HOUR = 2
const SAME_CODE_STREAK_BRIEF = 2

export function decideRecoveryDispatch(input: DispatchInput): DispatchDecision {
  if (input.recordIdDispatchedBefore) {
    return { path: 'skip', reason: 'record-already-dispatched', briefOnly: false }
  }
  if (!input.userOnline) {
    return { path: 'skip', reason: 'user-offline', briefOnly: false }
  }
  if (input.sessionDispatchCountLastHour >= MAX_PER_SESSION_PER_HOUR) {
    return { path: 'skip', reason: 'session-rate-limited', briefOnly: false }
  }
  const briefOnly = input.sameCodeStreak >= SAME_CODE_STREAK_BRIEF
  if (input.hasActiveRun) {
    return { path: 'followUp', reason: briefOnly ? 'active-run-brief' : 'active-run', briefOnly }
  }
  return { path: 'newTurn', reason: briefOnly ? 'idle-brief' : 'idle', briefOnly }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/server && ../../node_modules/.bin/vitest run src/agent/generation-recovery/recovery-dispatch.decider.test.ts 2>&1 | tail -5`
Expected: PASS（7/7）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/generation-recovery/
git commit -m "feat(server): 生成失败回注决策纯函数（PR3 Task1）"
```

---

### Task 2: 在线态代理（runs/events lastSeenAt）

**Files:**
- Modify: `apps/server/src/agent/agent.controller.ts`（:472-503 `runEvents` handler 内记 lastSeenAt）
- Create: `apps/server/src/agent/generation-recovery/presence.ts`（内存 Map + 纯函数判据）
- Test: `apps/server/src/agent/generation-recovery/presence.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DispatchInput`（供 Task 3 组装）
- Produces:
  - `recordSessionSeen(sessionKey: string, at?: number): void`
  - `isSessionOnline(sessionKey: string, now?: number, windowMs?: number): boolean`（默认 windowMs = 5 * 60 * 1000）
  - `__resetPresenceForTest(): void`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/agent/generation-recovery/presence.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { recordSessionSeen, isSessionOnline, __resetPresenceForTest } from './presence'

describe('presence（lastSeenAt 5min 窗口代理）', () => {
  beforeEach(__resetPresenceForTest)
  it('刚见过 → 在线', () => {
    recordSessionSeen('s1', 1_000_000)
    expect(isSessionOnline('s1', 1_000_000 + 60_000)).toBe(true)
  })
  it('超过 5 分钟 → 离线', () => {
    recordSessionSeen('s1', 1_000_000)
    expect(isSessionOnline('s1', 1_000_000 + 5 * 60_000 + 1)).toBe(false)
  })
  it('从未见过 → 离线', () => {
    expect(isSessionOnline('never-seen', 1_000_000)).toBe(false)
  })
  it('边界：恰好 5 分钟 → 仍在线（窗口含端点）', () => {
    recordSessionSeen('s1', 1_000_000)
    expect(isSessionOnline('s1', 1_000_000 + 5 * 60_000)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && ../../node_modules/.bin/vitest run src/agent/generation-recovery/presence.test.ts 2>&1 | tail -5`
Expected: FAIL

- [ ] **Step 3: 实现 + 接线 controller**

```ts
// apps/server/src/agent/generation-recovery/presence.ts
const lastSeen = new Map<string, number>()
const FIVE_MINUTES_MS = 5 * 60 * 1000

export function recordSessionSeen(sessionKey: string, at: number = Date.now()): void {
  lastSeen.set(sessionKey, at)
}

export function isSessionOnline(sessionKey: string, now: number = Date.now(), windowMs: number = FIVE_MINUTES_MS): boolean {
  const seen = lastSeen.get(sessionKey)
  if (seen === undefined) return false
  return now - seen <= windowMs
}

export function __resetPresenceForTest(): void {
  lastSeen.clear()
}
```

`agent.controller.ts` `runEvents` handler 内，`await this.sessionsService.findOne(...)` 之后加一行：

```ts
recordSessionSeen(threadId?.trim() || sessionId)
```

（import 自 `./generation-recovery/presence`。旁听流每 30s idle 重连即刷新 ⇒ 页面开着 ≈ 5 分钟窗口内必有见过。）

- [ ] **Step 4: 运行确认通过 + SSE 回归**

Run:
```bash
cd apps/server && ../../node_modules/.bin/vitest run src/agent/generation-recovery/presence.test.ts 2>&1 | tail -3
../../node_modules/.bin/vitest run src/agent/agent.controller 2>&1 | tail -3
```
Expected: 双 PASS（controller 既有测试不因加一行回归）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/generation-recovery/presence.ts apps/server/src/agent/generation-recovery/presence.test.ts apps/server/src/agent/agent.controller.ts
git commit -m "feat(server): runs/events lastSeenAt 在线态代理（PR3 Task2）"
```

---

### Task 3: 回注服务（限流 + 消息组装 + 双通道派发）

**Files:**
- Create: `apps/server/src/agent/generation-recovery/generation-recovery.service.ts`
- Test: `apps/server/src/agent/generation-recovery/generation-recovery.service.test.ts`

**Interfaces:**
- Consumes: Task 1 决策函数、Task 2 presence、既有 `AgentService.followUpPiRun`、`AgentService.steerPiRun`（不使用）、conversation 入口（经 `AgentService` 既有 prompt 方法，方法名以实现时 grep `async .*[Cc]onversation\|prompt` 结果为准）
- Produces:
  - `handleGenerationFailed(input: { sessionId: string; threadId?: string | null; nodeId: string; nodeTitle?: string; generationRecordId: string; errorCode?: string; userMessage: string; refundedPoints?: number }): Promise<DispatchDecision>`

- [ ] **Step 1: 背景确认（已核实，直接进入测试）**

conversation 路由无 ValidationPipe（`agent.controller.ts:531-536`）；`streamConversation` 为 async generator（`agent.service.ts:222`），宿主 drain 即全管线；本任务不需要 DTO 变更。

- [ ] **Step 2: 写失败测试（mock 依赖）**

```ts
// apps/server/src/agent/generation-recovery/generation-recovery.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GenerationRecoveryService } from './generation-recovery.service'
import { __resetPresenceForTest, recordSessionSeen } from './presence'

function makeAgent(over: Partial<Record<string, unknown>> = {}) {
  return {
    followUpPiRun: vi.fn(async () => ({ queued: true })),
    streamConversation: vi.fn(async function* () {
      yield { type: 'text_delta', data: { text: 'ok' } }
    }),
    ...over,
  } as never
}

const failInput = {
  sessionId: 'sess-1',
  threadId: 'thread-1',
  userId: 'user-1',
  nodeId: 'node-1',
  nodeTitle: '大灰狼视频',
  generationRecordId: 'rec-1',
  errorCode: 'upstream_timeout',
  userMessage: '上游超时',
  refundedPoints: 5,
}

describe('GenerationRecoveryService.handleGenerationFailed', () => {
  beforeEach(__resetPresenceForTest)

  it('空闲在线 → 走 newTurn（streamConversation drain），消息含结构化字段', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    const d = await svc.handleGenerationFailed(failInput)
    expect(d.path).toBe('newTurn')
    const calls = (agent as never as { streamConversation: { mock: { calls: unknown[][] } } }).streamConversation.mock.calls
    expect(calls.length).toBe(1)
    const arg = calls[0][0] as Record<string, string>
    expect(arg.sessionId).toBe('sess-1')
    expect(arg.userId).toBe('user-1')
    expect(arg.message).toContain('rec-1')
    expect(arg.message).toContain('upstream_timeout')
    expect(arg.message).toContain('已退回 5 积分')
  })

  it('活跃 run → 走 followUp，且不碰 streamConversation', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    const d = await svc.handleGenerationFailed({ ...failInput, hasActiveRun: true })
    expect(d.path).toBe('followUp')
    expect((agent as never as { followUpPiRun: { mock: { calls: unknown[][] } } }).followUpPiRun.mock.calls.length).toBe(1)
    expect((agent as never as { streamConversation: { mock: { calls: unknown[][] } } }).streamConversation.mock.calls.length).toBe(0)
  })

  it('同 record 二次调用 → skip 且不重复派发（幂等，poll+catch 双发射防护）', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    await svc.handleGenerationFailed(failInput)
    const d2 = await svc.handleGenerationFailed(failInput)
    expect(d2.path).toBe('skip')
    expect(d2.reason).toBe('record-already-dispatched')
    expect((agent as never as { streamConversation: { mock: { calls: unknown[][] } } }).streamConversation.mock.calls.length).toBe(1)
  })

  it('离线 → skip 且零派发', async () => {
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    const d = await svc.handleGenerationFailed(failInput)
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('user-offline')
    expect((agent as never as { followUpPiRun: { mock: { calls: unknown[][] } } }).followUpPiRun.mock.calls.length).toBe(0)
  })

  it('同因连败第 2 次 → briefOnly（消息为一句简报）', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    await svc.handleGenerationFailed(failInput)
    await svc.handleGenerationFailed({ ...failInput, generationRecordId: 'rec-2', hasActiveRun: true })
    const followCalls = (agent as never as { followUpPiRun: { mock: { calls: unknown[][] } } }).followUpPiRun.mock.calls
    expect(followCalls.length).toBe(1)
    const text = (followCalls[0][0] as Record<string, string>).text
    expect(text).toContain('一句话')
    expect(text).not.toContain('下一步选项')
  })

  it('消息文案禁自动 run_*（gate 兜底外的文案防线）', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    await svc.handleGenerationFailed(failInput)
    const arg = (agent as never as { streamConversation: { mock: { calls: unknown[][] } } }).streamConversation.mock.calls[0][0] as Record<string, string>
    expect(arg.message).toContain('不要')
    expect(arg.message).toContain('run_')
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `cd apps/server && ../../node_modules/.bin/vitest run src/agent/generation-recovery/generation-recovery.service.test.ts 2>&1 | tail -5`
Expected: FAIL

- [ ] **Step 4: 写最小实现**

```ts
// apps/server/src/agent/generation-recovery/generation-recovery.service.ts
import { Injectable } from '@nestjs/common'
import { decideRecoveryDispatch, type DispatchDecision } from './recovery-dispatch.decider'
import { isSessionOnline } from './presence'

export interface GenerationFailedInput {
  sessionId: string
  threadId?: string | null
  nodeId: string
  nodeTitle?: string
  generationRecordId: string
  errorCode?: string
  userMessage: string
  refundedPoints?: number
  /** 测试/编排注入：该会话当前是否有活跃 run。 */
  hasActiveRun?: boolean
}

@Injectable()
export class GenerationRecoveryService {
  /** recordId → 已派发时间（幂等，防 poll+catch 双发射）。 */
  private readonly dispatched = new Map<string, number>()
  /** sessionKey → 本小时派发时间列表（软限流，进程重启清零=可接受降级）。 */
  private readonly sessionDispatches = new Map<string, number[]>()
  /** nodeId → { errorCode, streak }：同因连败计数（spec §6.3 降级简报判据）。 */
  private readonly nodeCodeStreaks = new Map<string, { errorCode: string; streak: number }>()

  constructor(private readonly agent: {
    followUpPiRun(input: { sessionId: string; threadId?: string; text: string }): Promise<{ queued: boolean }>
    streamConversation(input: { sessionId: string; message: string; userId: string; threadId?: string }): AsyncGenerator<unknown>
  }) {}

  async handleGenerationFailed(input: GenerationFailedInput & { userId: string }): Promise<DispatchDecision> {
    const sessionKey = input.threadId?.trim() || input.sessionId
    const before = this.dispatched.has(input.generationRecordId)
    const streak = this.bumpStreak(input.nodeId, input.errorCode ?? 'unknown')
    const decision = decideRecoveryDispatch({
      hasActiveRun: input.hasActiveRun ?? false,
      userOnline: isSessionOnline(sessionKey),
      recordIdDispatchedBefore: before,
      sessionDispatchCountLastHour: this.countLastHour(sessionKey),
      sameCodeStreak: streak,
    })
    if (decision.path === 'skip') return decision

    const text = this.buildMessage(input, decision.briefOnly)
    if (decision.path === 'followUp') {
      await this.agent.followUpPiRun({ sessionId: input.sessionId, threadId: input.threadId ?? undefined, text })
    } else {
      // system-origin 新 turn：驱动既有 streamConversation 全管线（历史/retention/
      // finalizeTurn/persistCanvasEntities），drain 即跑完；事件经前端常驻 runs/events
      // 旁听流到达浏览器（pi-runtime subscribeLive 是多订户广播，session-manager.ts:1905）。
      void this.drainConversation(input.sessionId, input.userId, input.threadId, text)
    }    this.markDispatched(input.generationRecordId, sessionKey)
    return decision
  }

  private async drainConversation(sessionId: string, userId: string, threadId: string | null | undefined, text: string): Promise<void> {
    try {
      const stream = this.agent.streamConversation({
        sessionId,
        message: text,
        userId,
        threadId: threadId?.trim() || undefined,
      })
      for await (const _event of stream) {
        // 宿主无 SSE 调用方：事件由前端 runs/events 旁听流消费（见上），此处只驱动。
      }
    } catch {
      // 回注是旁路观察者：失败只留日志，绝不影响画布收敛（节点 error 态已先落成）。
    }
  }

  private bumpStreak(nodeId: string, errorCode: string): number {
    const prev = this.nodeCodeStreaks.get(nodeId)
    const streak = prev && prev.errorCode === errorCode ? prev.streak + 1 : 1
    this.nodeCodeStreaks.set(nodeId, { errorCode, streak })
    return streak
  }

  private countLastHour(sessionKey: string): number {
    const now = Date.now()
    const list = (this.sessionDispatches.get(sessionKey) ?? []).filter((t) => now - t <= 3_600_000)
    this.sessionDispatches.set(sessionKey, list)
    return list.length
  }

  private markDispatched(recordId: string, sessionKey: string): void {
    const now = Date.now()
    this.dispatched.set(recordId, now)
    const list = this.sessionDispatches.get(sessionKey) ?? []
    list.push(now)
    this.sessionDispatches.set(sessionKey, list)
  }

  private buildMessage(input: GenerationFailedInput, briefOnly: boolean): string {
    const head = `[系统事件·生成失败] node=${input.nodeId} record=${input.generationRecordId} reason=${input.errorCode ?? 'unknown'} detail=${input.userMessage} refund=${input.refundedPoints != null ? `已退回 ${input.refundedPoints} 积分` : 'none'}`
    if (briefOnly) {
      return `${head}\n请用一句话向用户说明失败原因与退款状态。`
    }
    return `${head}\n请：① 用一句话向用户说明失败原因与退款状态；② 给出下一步选项（改参数重试 / 换模型 / 放弃）；不要对该节点调用 run_*，等待用户选择。`
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd apps/server && ../../node_modules/.bin/vitest run src/agent/generation-recovery/generation-recovery.service.test.ts 2>&1 | tail -5`
Expected: PASS（5/5）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent/generation-recovery/generation-recovery.service.ts apps/server/src/agent/generation-recovery/generation-recovery.service.test.ts
git commit -m "feat(server): 生成失败回注服务——幂等/限流/消息契约/双通道（PR3 Task3）"
```

---

### Task 4: 发射点接线（orchestrator 两处失败终态）

**Files:**
- Modify: `apps/server/src/studio/video-generation.orchestrator.ts`（:116-135 poll terminal failed/error 分支、:147-159 catch 分支）
- Modify: `apps/server/src/studio/studio.module.ts`（若 GenerationRecoveryService 需跨模块可见，导出/导入；以现有 provider 装配方式为准）
- Test: `apps/server/src/studio/video-generation.orchestrator.recovery.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `GenerationRecoveryService.handleGenerationFailed`
- Produces: orchestrator 构造参数新增可选 `recovery?: GenerationRecoveryService`（缺省 = 不发射，flag off 语义）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/studio/video-generation.orchestrator.test.ts 同目录新增 recovery 用例组
// （挂载方式沿用该文件既有 orchestrator 构造模式；recovery 传 spy）
describe('失败终态发射（PR3 Task4）', () => {
  it('poll terminal = failed → handleGenerationFailed 收到 recordId/nodeId/sessionId', async () => {
    const recovery = { handleGenerationFailed: vi.fn(async () => ({ path: 'newTurn', reason: 'idle', briefOnly: false })) }
    // 构造 orchestrator（recovery spy 注入），mock pollGeneration 返回 { status: 'failed', ... }
    // 触发一次 run 后断言：
    expect(recovery.handleGenerationFailed).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-x', nodeId: 'node-x', generationRecordId: 'rec-x',
    }))
  })
  it('catch 分支（persist 抛错）同样发射一次', async () => { /* 同上，mock persist 抛错 */ })
  it('recovery 未注入（缺省）→ 零发射（flag off 逐字节旧行为）', async () => { /* 不传 recovery */ })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && ../../node_modules/.bin/vitest run src/studio/video-generation.orchestrator.recovery.test.ts 2>&1 | tail -5`
Expected: FAIL

- [ ] **Step 3: 接线（两处，均 fail-open）**

poll terminal 分支（:124-135 `finishData` 设置为 error 的路径）内，`await persist(errorActions)` **之后**加：

```ts
// 生成失败回注（spec §6）：发射点握有 canvas sessionId/nodeId/recordId 三要素。
// fail-open：回注失败绝不阻塞画布收敛（节点 error 态已先落成）。
if (this.recovery) {
  void this.recovery.handleGenerationFailed({
    sessionId: input.sessionId,
    userId, // 与 pollGeneration(userId, ...) 同参；streamConversation 全管线要求 userId（piEligible）
    nodeId: input.nodeId,
    generationRecordId: recordId,
    errorCode: undefined, // poll 终态不带结构化 errorCode，detail 用 errorMessage
    userMessage: finishData.errorMessage ?? '视频生成失败',
  }).catch(() => undefined)
}
```

catch 分支（:157 `await persist(errorActions)` 之后）加同型调用，`userMessage: errorMessage`。

> ⚠️ 两处都 `void ...catch()`：回注是旁路观察者，抛错只能被吞掉且**不得**影响 orchestrator 返回值（既有测试断言返回值形状）。

- [ ] **Step 4: 运行确认通过 + orchestrator 全量回归**

Run:
```bash
cd apps/server && ../../node_modules/.bin/vitest run src/studio/video-generation.orchestrator.recovery.test.ts src/studio/video-generation 2>&1 | tail -5
```
Expected: 新用例 PASS + 既有 orchestrator/integration 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/studio/video-generation.orchestrator.ts apps/server/src/studio/video-generation.orchestrator.recovery.test.ts apps/server/src/studio/studio.module.ts
git commit -m "feat(server): orchestrator 失败终态接入回注发射（PR3 Task4）"
```

---

### Task 5: system-origin turn 的浏览器到达路径 + web 系统事件渲染

**Files:**
- Modify: `apps/web/src/components/agent/`（渲染归因点以实现时 grep `role.*user` 消息渲染处为准——侧栏用户气泡组件）
- Test: 渲染点对应测试文件（新建 `system-event-render.test.ts` 或追加进既有 reducer/组件测试）

**Interfaces:**
- Consumes: Task 3 的 `streamConversation` drain（服务侧无 SSE 调用方，事件经前端常驻 `runs/events` 旁听流到达）
- Produces: 无（渲染）

**背景事实（已核实，写死在此防实现期漂移）：**
- pi-runtime `subscribeLive` 是多订户广播（`session-manager.ts:1905`，listeners Set）⇒ 宿主 drain 的 turn 事件会推给**所有**订阅者，含前端 `runs/events` 旁听流（30s idle 重连，断线续传靠 seq）。
- `streamConversation` 是 async generator（`agent.service.ts:222`）：宿主侧 drain = 跑完全管线（落库/retention/finalizeTurn）。
- conversation 路由无 `@UsePipes(ValidationPipe)`（`agent.controller.ts:531-536`）⇒ DTO 装饰器惰性，**但本方案不需要加 origin 字段**（见下）。
- **origin 判定走文本前缀，不走元数据**：system-origin 消息以 `[系统事件·生成失败]` 开头（Task 3 `buildMessage` 的 head），web 对该前缀的用户消息渲染为系统事件样式。与 followUp 路径（lane 纯文本、无元数据通道，`agent.service.ts:595-599`）保持同一判据，不为一条通知发明元数据通道（spec §8 非目标）。

- [ ] **Step 1: 写失败测试（渲染）**

```ts
// apps/web/src/components/agent/system-event-render.test.ts
import { describe, it, expect } from 'vitest'
import { isSystemEventText } from './systemEventRender' // 下一步实现

describe('isSystemEventText', () => {
  it('[系统事件· 前缀 → 系统事件', () => {
    expect(isSystemEventText('[系统事件·生成失败] node=x record=y')).toBe(true)
  })
  it('普通用户消息 → 非系统事件', () => {
    expect(isSystemEventText('帮我把这张图做成视频')).toBe(false)
  })
  it('空/非字符串 → false', () => {
    expect(isSystemEventText('')).toBe(false)
    expect(isSystemEventText(undefined as never)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && ../../node_modules/.bin/vitest run src/components/agent/system-event-render.test.ts 2>&1 | tail -5`
Expected: FAIL

- [ ] **Step 3: 实现纯函数 + 渲染分支**

```ts
// apps/web/src/components/agent/systemEventRender.ts
const SYSTEM_EVENT_PREFIX = '[系统事件·'

/** 宿主回注消息判据（spec §6.4）：文本前缀即真相，与 followUp/newTurn 两路同源。 */
export function isSystemEventText(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(SYSTEM_EVENT_PREFIX)
}
```

渲染分支：grep 侧栏用户消息气泡的渲染处（`role === 'user'` 的模板/组件），加 `isSystemEventText(msg.text)` 判定 ⇒ 系统事件样式（左侧竖线 + 「系统」标签）。样式类名**只消费设计令牌 L2/L3**（禁新增 hex——`design-token.test.ts` 守卫）。

- [ ] **Step 4: 运行确认通过 + 守卫**

Run:
```bash
cd apps/web && ../../node_modules/.bin/vitest run src/components/agent/ src/styles/design-token.test.ts 2>&1 | tail -5
```
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/systemEventRender.ts apps/web/src/components/agent/system-event-render.test.ts apps/web/src/components/agent/
git commit -m "feat(web): system-origin 消息按文本前缀渲染为系统事件（PR3 Task5）"
```

---

### Task 6: PR 前回归 + flag 灰度

**Files:**
- Modify: 无（flag 接线若未在 Task 3/4 默认 off 完成，在此补）

- [ ] **Step 1: 全量相关测试**

Run:
```bash
cd apps/server && ../../node_modules/.bin/vitest run src/agent/generation-recovery src/studio/video-generation src/agent/agent.controller 2>&1 | tail -8
```
Expected: 全 PASS

- [ ] **Step 2: flag off 回归断言**

Run: `cd apps/server && ../../node_modules/.bin/vitest run src/studio/video-generation.orchestrator.recovery.test.ts -t "零发射" 2>&1 | tail -3`
Expected: PASS（不注入 recovery = 逐字节旧行为）

- [ ] **Step 3: 推送 + 开 PR**

```bash
git push -u origin <branch>
gh pr create --base master --title "feat(server+web): 生成失败 agent 回注端到端闭环（PR3/②）" --body "实现 spec §6。followUp 尾随 / system-origin 新 turn / 离线 skip；限流三规则；flag 默认 off。发射点=video orchestrator 两处失败终态（poll+catch，幂等去重）。"
```

- [ ] **Step 4: 盯 CI 全绿后 squash 合并，转 prod-deploy-verify**

```bash
gh pr checks <n>
gh pr merge <n> --squash
```
