import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportWaitResolved, reportWaitStarted } from './waitTelemetry'

describe('waitTelemetry（T4：等待态打点）', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
  })
  afterEach(() => {
    debugSpy.mockRestore()
  })

  it('started：首次上报 agent_wait_started；同 callId 重放只报一次', () => {
    reportWaitStarted('proposal', 'c1', { nodeId: 'n1', timeoutMs: 60000 })
    expect(debugSpy).toHaveBeenCalledTimes(1)
    const [, name, payload] = debugSpy.mock.calls[0]!
    expect(name).toBe('agent_wait_started')
    expect(payload).toEqual({ kind: 'proposal', callId: 'c1', nodeId: 'n1', timeoutMs: 60000 })

    // waiting_user upsert 重放：不重复上报
    reportWaitStarted('proposal', 'c1')
    expect(debugSpy).toHaveBeenCalledTimes(1)
  })

  it('resolved：durationMs = now - startedAt（时长取自 part.startedAt）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      reportWaitResolved('question', 'q1', 'answered', 1_000_000 - 15_000)
      const [, name, payload] = debugSpy.mock.calls[0]!
      expect(name).toBe('agent_wait_resolved')
      expect(payload).toMatchObject({
        kind: 'question',
        callId: 'q1',
        outcome: 'answered',
        durationMs: 15_000,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolved：startedAt 缺失 → durationMs null（不猜）', () => {
    reportWaitResolved('proposal', 'c2', 'confirmed')
    const [, , payload] = debugSpy.mock.calls[0]!
    expect(payload).toHaveProperty('durationMs', null)
  })

  it('终态后同 callId 可重新计 started（幂等键清理）', () => {
    reportWaitStarted('question', 'q9')
    reportWaitResolved('question', 'q9', 'skipped', Date.now())
    const callsAfterResolve = debugSpy.mock.calls.length
    reportWaitStarted('question', 'q9')
    expect(debugSpy.mock.calls.length).toBe(callsAfterResolve + 1)
  })

  it('空 callId 直接忽略', () => {
    reportWaitStarted('proposal', '')
    reportWaitResolved('question', '', 'answered')
    expect(debugSpy).not.toHaveBeenCalled()
  })
})
