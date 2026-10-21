import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TurnAutoResumeService } from './turn-auto-resume.service'
import { __resetPresenceForTest, recordSessionSeen } from '../generation-recovery/presence'

function makeAgent(over: Partial<Record<string, unknown>> = {}) {
  return {
    streamConversation: vi.fn(async function* () {
      yield { type: 'text_delta', data: { text: 'ok' } }
    }),
    ...over,
  } as never
}

const baseInput = {
  sessionId: 'sess-1',
  userId: 'user-1',
  threadId: 'thread-1',
  turnKey: 'msg-1@1700000000000',
  failed: true,
  interruption: 'upstream_error',
}

describe('TurnAutoResumeService.handleTurnFailed', () => {
  beforeEach(() => {
    __resetPresenceForTest()
    process.env.TURN_AUTO_RESUME_ENABLED = 'true'
  })

  it('⭐ flag off ⇒ 零派发（不碰 client）', async () => {
    process.env.TURN_AUTO_RESUME_ENABLED = 'false'
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)
    const d = await svc.handleTurnFailed(baseInput)
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('flag-off')
    expect(
      (agent as never as { streamConversation: { mock: { calls: unknown[][] } } })
        .streamConversation.mock.calls.length,
    ).toBe(0)
  })

  it('⭐ 失败 + 用户不在场 ⇒ 新开一轮（streamConversation drain）', async () => {
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)
    const d = await svc.handleTurnFailed(baseInput)
    expect(d.path).toBe('newTurn')
    const calls = (
      agent as never as { streamConversation: { mock: { calls: unknown[][] } } }
    ).streamConversation.mock.calls
    expect(calls.length).toBe(1)
    expect(calls[0][0]).toBe('sess-1')
    expect(calls[0][2]).toBe('user-1')
    expect(calls[0][3]).toBe('thread-1')
  })

  it('⭐ 注入文本含「接着做」且**不重复**状态内容（状态由 turnState 动态块提供）', async () => {
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)
    await svc.handleTurnFailed(baseInput)
    const calls = (
      agent as never as { streamConversation: { mock: { calls: unknown[][] } } }
    ).streamConversation.mock.calls
    const message = calls[0][1] as string
    expect(message).toContain('接着')
    expect(message).toContain('不要道歉')
    expect(message).toContain('不要复盘')
    // ⛔ 不得重复状态内容（否则模型会以为状态出现两次）
    expect(message).not.toContain('用户当时的请求')
    expect(message).not.toContain('未完成：')
  })

  it('⭐ idempotencyKey 落第 5 位（streamConversation 位置参数）+ billingSource 落末位', async () => {
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)
    await svc.handleTurnFailed(baseInput)
    const calls = (
      agent as never as { streamConversation: { mock: { calls: unknown[][] } } }
    ).streamConversation.mock.calls
    expect(calls[0][4]).toBe(baseInput.turnKey)
    expect(calls[0][15]).toBe('automation')
  })

  it('⭐ 用户在场 ⇒ 不派发（别抢用户意图）', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)
    const d = await svc.handleTurnFailed(baseInput)
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('user-online')
    expect(
      (agent as never as { streamConversation: { mock: { calls: unknown[][] } } })
        .streamConversation.mock.calls.length,
    ).toBe(0)
  })

  it('⭐ 幂等：同一 turnKey 第二次 ⇒ skip', async () => {
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)
    await svc.handleTurnFailed(baseInput)
    const d = await svc.handleTurnFailed(baseInput)
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('turn-already-dispatched')
    expect(
      (agent as never as { streamConversation: { mock: { calls: unknown[][] } } })
        .streamConversation.mock.calls.length,
    ).toBe(1)
  })

  it('⭐ 限流：同会话第二轮（不同 turnKey）⇒ skip（每小时上限 1）', async () => {
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)
    await svc.handleTurnFailed(baseInput)
    const d = await svc.handleTurnFailed({ ...baseInput, turnKey: 'msg-2@1700000001000' })
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('session-rate-limited')
  })

  it('⭐ 同因连败第 2 次 ⇒ 降级 skip（不无限重试）', async () => {
    // ⭐⭐ 关键：连败门是**长窗口**防线 ⇒ 必须跨过 1 小时（限流额度重置）才可能触发。
    // 同小时内第 2 次会被**限流门**先拦下（reason=session-rate-limited）——
    // 那正是两道防线互补的证据，不是缺陷。
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)

    const realNow = Date.now
    const t0 = realNow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    try {
      // 第 1 次：派发成功（消耗本小时的限流额度，streak=1）
      const first = await svc.handleTurnFailed({ ...baseInput, turnKey: 'k1' })
      expect(first.path).toBe('newTurn')

      // 跨过 1 小时 ⇒ 限流额度重置，但 streak 仍是 1
      nowSpy.mockReturnValue(t0 + 3_600_001)
      const d = await svc.handleTurnFailed({ ...baseInput, turnKey: 'k2' })
      expect(d.path).toBe('skip')
      expect(d.degraded).toBe(true)
      expect(d.reason).toBe('same-thread-streak')
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('⭐ 同小时内第 2 次 ⇒ 限流门先拦（reason=session-rate-limited，非 degraded）', async () => {
    // ⭐ 两道防线的**顺序**证据：短窗口（限流）先于长窗口（连败）触发。
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)
    await svc.handleTurnFailed({ ...baseInput, turnKey: 'k1' })
    const d = await svc.handleTurnFailed({ ...baseInput, turnKey: 'k2' })
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('session-rate-limited')
    expect(d.degraded).toBe(false)
  })

  it('⭐ 不同原因不算连败（streak 重置 ⇒ 仍可派发）', async () => {
    // ⭐ 跨过 1 小时（限流额度重置）后：同会话但**不同**原因 ⇒ streak 重置为 1
    // ⇒ 不触发连败门 ⇒ 可以派发。
    const agent = makeAgent()
    const svc = new TurnAutoResumeService(agent as never)
    const realNow = Date.now
    const t0 = realNow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    try {
      await svc.handleTurnFailed({ ...baseInput, threadId: 'thread-3', turnKey: 'k1' })
      nowSpy.mockReturnValue(t0 + 3_600_001)
      const d = await svc.handleTurnFailed({
        ...baseInput,
        threadId: 'thread-3',
        turnKey: 'k2',
        interruption: 'history_diverged',
      })
      expect(d.path).toBe('newTurn')
      expect(d.degraded).toBe(false)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('⛔ client 抛错 ⇒ 不冒泡（旁路观察者，绝不影响本轮收尾）', async () => {
    const agent = {
      streamConversation: vi.fn(async function* () {
        throw new Error('boom')
        // eslint-disable-next-line no-unreachable
        yield { type: 'text_delta' }
      }),
    } as never
    const svc = new TurnAutoResumeService(agent as never)
    await expect(svc.handleTurnFailed(baseInput)).resolves.toBeDefined()
  })
})
