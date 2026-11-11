/**
 * 2026-11-11 插话消费终态（规格 docs/superpowers/specs/2026-11-11-queue-user-bubble-context-verify-design.md）：
 * user_utterance_queued / consumed / stuck 三事件的 store 消费面。
 *
 * 数据链路：服务端 SessionEventBus 扇出 → runEventStream yield `user_utterance_*` 帧
 * → AgentSideRail switch 分支 → store 动作（插入带 queued 的插话气泡 / 按 entryId 翻
 * queued=false / 标 reconciled）→ 徽标「待接住 / 未接住」。
 *
 * ⭐ 变异自检映射（判据不锚在实现函数名上）：
 *   - 删掉 consumed 分支 ⇒ consumed 翻转红
 *   - 翻转改按 id 而非 entryId ⇒ entryId 定位红
 *   - 幂等去掉（重复翻转报错/重复插入）⇒ 幂等红
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'

const persistedBase = {
  sessionId: 's1',
  createdAt: '2026-11-11T00:00:00.000Z',
}

describe('插话消费终态（user_utterance_*，2026-11-11）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('历史面：reconciled 只对 user 行透传；queued+reconciled ⇒ 「未接住」数据成立', () => {
    const store = useAgentStore()
    store.loadHistory([
      { ...persistedBase, id: 'm1', role: 'user', content: '滞留插话', queued: true, reconciled: true },
      { ...persistedBase, id: 'm2', role: 'user', content: '待接住插话', queued: true },
      { ...persistedBase, id: 'm3', role: 'assistant', content: '回答', reconciled: true },
    ] as never)
    expect(store.messages.find((m) => m.id === 'm1')?.queued).toBe(true)
    expect(store.messages.find((m) => m.id === 'm1')?.reconciled).toBe(true)
    expect(store.messages.find((m) => m.id === 'm2')?.reconciled).toBe(false)
    // assistant 行 reconciled 异常值不透出（渲染层 role 门 + 此处归一）
    expect(store.messages.find((m) => m.id === 'm3')?.reconciled).toBe(false)
  })

  it('insertUserMessageBeforeAssistant：queued 标记随 extras 落位（user_utterance_queued 数据源）', () => {
    const store = useAgentStore()
    store.loadHistory([
      { ...persistedBase, id: 'a1', role: 'assistant', content: '在跑的回答' },
    ] as never)
    const msg = store.insertUserMessageBeforeAssistant('加一只猫', { entryId: 'E1', queued: true })
    expect(msg.queued).toBe(true)
    expect(msg.entryId).toBe('E1')
    // 落点在最后一条 assistant 之前（顺序不乱）
    expect(store.messages.findIndex((m) => m.id === msg.id)).toBe(0)
  })

  it('markMessageUtteranceConsumed：按 entryId 翻 queued=false；未知/缺省 entryId 幂等 no-op；重复调用幂等', () => {
    const store = useAgentStore()
    store.loadHistory([
      { ...persistedBase, id: 'a1', role: 'assistant', content: '在跑的回答' },
    ] as never)
    store.insertUserMessageBeforeAssistant('加一只猫', { entryId: 'E1', queued: true })
    store.markMessageUtteranceConsumed('E1')
    expect(store.messages.find((m) => m.entryId === 'E1')?.queued).toBe(false)
    // 重复事件（双通道：pi_message_end + user_utterance_consumed）不抛、不变
    expect(() => store.markMessageUtteranceConsumed('E1')).not.toThrow()
    expect(store.messages.find((m) => m.entryId === 'E1')?.queued).toBe(false)
    // 未知 entryId / 缺省：no-op
    expect(() => store.markMessageUtteranceConsumed('E-missing')).not.toThrow()
    expect(() => store.markMessageUtteranceConsumed('')).not.toThrow()
  })

  it('markMessageUtteranceStuck：按 entryId 标 reconciled；未命中不抛', () => {
    const store = useAgentStore()
    store.insertUserMessageBeforeAssistant('在两之间有连线吗', { entryId: 'E2', queued: true })
    store.markMessageUtteranceStuck('E2')
    expect(store.messages.find((m) => m.entryId === 'E2')?.reconciled).toBe(true)
    expect(() => store.markMessageUtteranceStuck('E-missing')).not.toThrow()
    expect(() => store.markMessageUtteranceStuck('')).not.toThrow()
  })

  it('consumed 不清 reconciled、stuck 不清 queued（两终态正交，徽标判定 queued&&reconciled）', () => {
    const store = useAgentStore()
    store.insertUserMessageBeforeAssistant('滞留插话', { entryId: 'E3', queued: true })
    store.markMessageUtteranceStuck('E3')
    const row = store.messages.find((m) => m.entryId === 'E3')
    expect(row?.queued).toBe(true)
    expect(row?.reconciled).toBe(true)
  })
})
