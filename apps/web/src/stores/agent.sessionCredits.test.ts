import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'
import { useAuthStore } from './auth'

/** 2026-11-03 会话积分常驻条数据源：sessionConsumedCredits 单一口径。 */
describe('sessionConsumedCredits（本会话累计已消耗）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('流式期间 = 0（无 settled）+ 当前回合实时预估', async () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    expect(store.sessionConsumedCredits).toBe(0)
    store.startAssistantMessage()
    store.trackUsageDelta({ estimatedCredits: 3 })
    expect(store.sessionConsumedCredits).toBe(3)
  })

  it('结算到达 → 权威值替代预估（不重不漏：3 预估 → 结算 14 后累计=14）', async () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.startAssistantMessage()
    store.trackUsageDelta({ estimatedCredits: 3 })
    store.trackTurnSettled({ holdId: 'h1', credits: 14, model: 'agnes-2.5-flash' })
    expect(store.sessionConsumedCredits).toBe(14)
  })

  it('跨回合累加：14 + 7 = 21；released（全退）回合不计入', async () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.startAssistantMessage()
    store.trackTurnSettled({ holdId: 'h1', credits: 14 })
    store.startAssistantMessage()
    store.trackTurnSettled({ holdId: 'h2', credits: 7 })
    expect(store.sessionConsumedCredits).toBe(21)
    store.startAssistantMessage()
    store.trackTurnSettled({ holdId: 'h3', released: true })
    expect(store.sessionConsumedCredits).toBe(21)
  })

  it('时间线消息（无 executionTrace 落点失败时）也能经 timeline.settled 摘要——store 侧 settled 仍以 trace 为准', async () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.startAssistantMessage()
    store.trackTurnSettled({ holdId: 'h1', credits: 14, model: 'agnes-2.5-flash' })
    const last = store.messages[store.messages.length - 1]
    // 双结构同源：trace.settled（累计口径）与 timeline.settled（摘要口径）一次事件双写
    expect(last?.executionTrace?.settled?.credits).toBe(14)
    expect(last?.executionTrace?.settled?.model).toBe('agnes-2.5-flash')
    expect(last?.timeline?.settled?.credits).toBe(14)
    expect(last?.timeline?.settled?.model).toBe('agnes-2.5-flash')
  })
})
