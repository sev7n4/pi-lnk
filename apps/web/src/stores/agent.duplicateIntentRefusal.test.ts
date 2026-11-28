import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'

describe('turnRefusal：重复意图拒绝的结构化详情', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('setTurnRefusal 携带 duplicate_intent 详情（含被拒原话，供强制重发）', () => {
    const store = useAgentStore()
    store.setTurnRefusal('duplicate_intent', {
      message: '继续推进',
      status: 'completed',
      createdAt: '2026-11-28T10:41:59.000Z',
      hasResult: false,
    })

    expect(store.turnRefusal).toBe('duplicate_intent')
    expect(store.turnRefusalDetail).toMatchObject({
      message: '继续推进',
      status: 'completed',
      hasResult: false,
    })
  })

  it('新回合开始清位，不跨回合误显示', () => {
    const store = useAgentStore()
    store.setTurnRefusal('duplicate_intent', { message: '画一只红车' })
    store.addUserMessage('画一只蓝车')

    expect(store.turnRefusal).toBeNull()
    expect(store.turnRefusalDetail).toBeNull()
  })

  it('旧 reason 的调用方式不变（第二参可省）', () => {
    const store = useAgentStore()
    store.setTurnRefusal('not_idle')
    expect(store.turnRefusal).toBe('not_idle')
    expect(store.turnRefusalDetail).toBeNull()
  })
})
