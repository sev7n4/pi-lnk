/**
 * P4-T3（M1 投影重建）：loadHistory 不得整体替换（spec 2026-10-21 §4.3 M1 / §8 mergeHistoryAndLive）。
 *
 * 场景：本地乐观气泡（刚 push、还没等到服务端行）与历史加载并发——
 * 旧实现 `messages.value = history.map(...)` 会把本地新增**整批吞掉**；
 * 本测试就是 spec §10.2 的变异检测器：把合并改回整体替换 ⇒ 用例 1/2/4 红。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'

const persistedBase = {
  sessionId: 's1',
  createdAt: '2026-11-05T00:00:00.000Z',
}

describe('loadHistory 合并语义（M1，P4-T3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('① 历史到达时本地已有未落库的 user 气泡 ⇒ 保留在尾部（变异点：整体替换⇒红）', () => {
    const store = useAgentStore()
    store.addUserMessage('刚发的话')
    store.loadHistory([
      { ...persistedBase, id: 'm1', role: 'user', content: '历史消息' },
      { ...persistedBase, id: 'm2', role: 'assistant', content: '历史回答', createdAt: '2026-11-05T00:00:10.000Z' },
    ] as never)
    const ids = store.messages.map((m) => m.id)
    expect(ids).toContain('m1')
    expect(ids).toContain('m2')
    // 本地气泡在历史之后（时间序）
    const local = store.messages.find((m) => m.content === '刚发的话')
    expect(local, '本地新增被整体替换吞掉 = M1 复发').toBeDefined()
    expect(ids.indexOf(local!.id)).toBeGreaterThan(ids.indexOf('m2'))
  })

  it('② 本地 user 气泡已被历史覆盖（同内容、60s 窗内）⇒ 去重不双气泡', () => {
    const store = useAgentStore()
    store.addUserMessage('同一句话')
    store.loadHistory([
      // 服务端行：与本地气泡同内容、createdAt 距本地 push 不到 60s（+20s 模拟时钟偏差）
      { ...persistedBase, id: 'm1', role: 'user', content: '同一句话', createdAt: new Date(Date.now() + 20_000).toISOString() },
    ] as never)
    const userRows = store.messages.filter((m) => m.role === 'user' && m.content === '同一句话')
    expect(userRows.length, '同一条发言不得出现两个气泡').toBe(1)
    // 保留的是**权威行**（服务端 id），不是本地 id
    expect(userRows[0]!.id).toBe('m1')
  })

  it('③ 内容相同但超出 60s 窗 ⇒ 不误杀（两条真实消息都在）', () => {
    const store = useAgentStore()
    // 伪造一条很早的本地消息：直接塞进 messages（绕过 addUserMessage 的 now 时间戳）
    store.addUserMessage('继续')
    // 把它的 localCreatedAt 拨回 10 分钟前
    const local = store.messages[store.messages.length - 1]!
    local.localCreatedAt = Date.parse('2026-11-05T00:00:00.000Z')
    store.loadHistory([
      { ...persistedBase, id: 'm1', role: 'user', content: '继续', createdAt: '2026-11-05T00:10:00.000Z' },
    ] as never)
    const rows = store.messages.filter((m) => m.role === 'user' && m.content === '继续')
    expect(rows.length, '窗外的同文消息是两条真实发言，不得去重').toBe(2)
  })

  it('④ 本地 streaming 中的 assistant 气泡：历史尚无 assistant 行 ⇒ 保留（live 权威）', () => {
    const store = useAgentStore()
    store.addUserMessage('问')
    store.startAssistantMessage()
    store.loadHistory([
      { ...persistedBase, id: 'm1', role: 'user', content: '问', createdAt: '2026-11-05T00:00:00.000Z' },
    ] as never)
    // 本流仍在跑：本地 user 气泡与历史行是同一条（去重），streaming 气泡必须还在
    const streaming = store.messages.find((m) => m.role === 'assistant' && m.streaming)
    expect(streaming, '流式中的气泡被吞 = 实时进度丢失').toBeDefined()
  })

  it('⑤ 本地 streaming assistant 气泡：历史已有晚于其起点的 assistant 行 ⇒ 让位权威行（重连陈旧气泡清除）', () => {
    const store = useAgentStore()
    store.addUserMessage('旧回合的问题')
    const streaming = store.startAssistantMessage()
    // 把本地气泡起点拨回 1 分钟前；历史里已有该回合的最终行（finalizeTurn 产物）
    streaming.localCreatedAt = Date.parse('2026-11-05T00:00:00.000Z')
    store.loadHistory([
      { ...persistedBase, id: 'm1', role: 'user', content: '旧回合的问题', createdAt: '2026-11-05T00:00:00.000Z' },
      { ...persistedBase, id: 'm2', role: 'assistant', content: '最终回答', createdAt: '2026-11-05T00:00:30.000Z' },
    ] as never)
    expect(
      store.messages.find((m) => m.role === 'assistant' && m.streaming),
      '陈旧流式气泡不得与权威行并存',
    ).toBeUndefined()
    expect(store.messages.find((m) => m.id === 'm2')).toBeDefined()
  })

  it('⑥ 按 id 命中的本地行直接让位（服务端行权威，即使内容窗不匹配）', () => {
    const store = useAgentStore()
    store.addUserMessage('有回执的话')
    // 模拟本地行已被服务端确认换过 id（P0 对账回填形态）：本地 id 出现在历史中
    const local = store.messages[store.messages.length - 1]!
    local.id = 'srv-1'
    store.loadHistory([
      { ...persistedBase, id: 'srv-1', role: 'user', content: '有回执的话（服务端版）' },
    ] as never)
    const rows = store.messages.filter((m) => m.role === 'user')
    expect(rows.length).toBe(1)
    expect(rows[0]!.content).toBe('有回执的话（服务端版）')
  })
})
