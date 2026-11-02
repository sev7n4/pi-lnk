import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'
import { useAuthStore } from './auth'

describe('trackTurnSettled 预估覆盖（修复规格 2026-11-02-points-display-single-source）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('turn_settled 后 liveEstimatedCredits 清零（预估不残留为最终数字）', async () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.startAssistantMessage()
    store.trackTurnUsage({ inputTokens: 100, outputTokens: 50, estimatedCredits: 2 })
    expect(store.liveEstimatedCredits).toBe(2)
    store.trackTurnSettled({ holdId: 'h', credits: 14 })
    expect(store.liveEstimatedCredits).toBeNull()
  })

  it('turn_settled 清预估后，状态行 settled 态显示权威 credits 而非预估', async () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.startAssistantMessage()
    store.trackTurnUsage({ inputTokens: 3000, outputTokens: 400, estimatedCredits: 2 })
    store.trackTurnSettled({ holdId: 'h1', credits: 14, breakdown: { in: 3000, cache: 0, out: 400 } })
    const last = store.messages[store.messages.length - 1]
    // reducer 同源文案：结算权威值覆盖预估
    expect(last?.executionTrace?.settled?.credits).toBe(14)
  })
})
