/**
 * P3 D5（Task 5/6）：queued 的 web 消费面。
 *
 * 数据链路：server getMessages **读时派生**（`row.queued && 无更晚 assistant 行`）
 * → loadHistory / prependHistory 经 mapPersistedToMessage 进视图消息
 * → AgentSideRail user 气泡渲染「排队中」徽标。
 *
 * 实时清除：own-turn 收到 `turn_ack{messageId}`（P3 G4 落库补齐产物）⇒
 * consumeQueued 把对应行翻 false（刷新后重连场景；本地直发气泡 queued 未设，no-op）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'

const persistedBase = {
  sessionId: 's1',
  createdAt: '2026-11-05T00:00:00.000Z',
}

describe('store queued 透传与消费（P3 D5）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('loadHistory：queued:true 的 user 行透传进视图消息；缺省/undefined ⇒ 不污染', () => {
    const store = useAgentStore()
    store.loadHistory([
      { ...persistedBase, id: 'm1', role: 'user', content: '插话', queued: true },
      { ...persistedBase, id: 'm2', role: 'user', content: '普通' },
      { ...persistedBase, id: 'm3', role: 'assistant', content: '回答', queued: true },
    ] as never)
    expect(store.messages.find((m) => m.id === 'm1')?.queued).toBe(true)
    expect(store.messages.find((m) => m.id === 'm2')?.queued).toBe(false)
    // assistant 行即使 DB 列异常为 true 也不渲染徽标（渲染层 role 门 + 此处归一）
    expect(store.messages.find((m) => m.id === 'm3')?.queued).toBe(false)
  })

  it('prependHistory：翻页补进头部的行同样透传 queued', () => {
    const store = useAgentStore()
    store.loadHistory([
      { ...persistedBase, id: 'm2', role: 'user', content: '已有' },
    ] as never)
    store.prependHistory([
      { ...persistedBase, id: 'm0', role: 'user', content: '翻页旧消息', queued: true },
    ] as never)
    expect(store.messages.find((m) => m.id === 'm0')?.queued).toBe(true)
  })

  it('consumeQueued：按 messageId 把行翻 false；未知 id 幂等 no-op', () => {
    const store = useAgentStore()
    store.loadHistory([
      { ...persistedBase, id: 'm1', role: 'user', content: '插话', queued: true },
    ] as never)
    store.consumeQueued('m1')
    expect(store.messages.find((m) => m.id === 'm1')?.queued).toBe(false)
    expect(() => store.consumeQueued('nonexistent')).not.toThrow()
  })
})
