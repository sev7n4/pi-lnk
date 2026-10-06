import { describe, expect, it, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentStore } from './agent'

/**
 * SEL-REF 前端侧不变量 ①：逐消息携带。
 *
 * 回执的数据源是**该条消息发出时冻结的 id 快照**（Review Focus #5）——
 * 用户发送后改选，回执仍须与实际发出的内容一致。
 *
 * 不变量 ②（上行 payload 只含 selectedNodeIds、不含 focusNodeId）在
 * `components/agent/AgentSideRail.sel-ref.test.ts`。
 */
describe('SEL-REF · agent store 逐消息携带 selectionNodeIds', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('addUserMessage 把 selectionNodeIds 复制进该条消息', () => {
    const s = useAgentStore()
    s.addUserMessage('这个节点是什么', { selectionNodeIds: ['a', 'b'] })
    expect(s.messages[0].selectionNodeIds).toEqual(['a', 'b'])
  })

  it('Review Focus #5：存的是**副本**，外部数组后续改动不影响已发消息', () => {
    const s = useAgentStore()
    const ids = ['a']
    s.addUserMessage('hi', { selectionNodeIds: ids })
    ids.push('b')
    expect(s.messages[0].selectionNodeIds).toEqual(['a'])
  })

  it('空数组 ⇒ 不写字段（缺省与"传了但为空"必须可区分）', () => {
    const s = useAgentStore()
    s.addUserMessage('hi', { selectionNodeIds: [] })
    expect(s.messages[0].selectionNodeIds).toBeUndefined()
  })

  it('缺省 extras 时不写该字段', () => {
    const s = useAgentStore()
    s.addUserMessage('hi')
    expect(s.messages[0].selectionNodeIds).toBeUndefined()
  })
})

// ── 评审 C1：回执须由服务端 selection_binding 事件确认 ──────────────────────
// 前端读不到 Nest 的 SEL_REF_ENABLED ⇒ 不能自己推断「是否真注入了」。
// 只有收到服务端事件才把 confirmed 挂到**那条 user 消息**上。
describe('SEL-REF · agent store 接收服务端确认（评审 C1）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('confirmSelectionBinding 把确认结果挂到最近一条 user 消息', () => {
    const s = useAgentStore()
    s.addUserMessage('这个是什么', { selectionNodeIds: ['a', 'b'] })
    s.startAssistantMessage()
    s.confirmSelectionBinding([{ id: 'a', type: 'image', title: '小柚定妆照' }])
    expect(s.messages[0].selectionBindingConfirmed).toEqual([
      { id: 'a', type: 'image', title: '小柚定妆照' },
    ])
  })

  it('空确认数组 ⇒ **不写**该字段（= 服务端没注入 ⇒ chip 不渲染）', () => {
    const s = useAgentStore()
    s.addUserMessage('这个是什么', { selectionNodeIds: ['a'] })
    s.confirmSelectionBinding([])
    expect(s.messages[0].selectionBindingConfirmed).toBeUndefined()
  })

  it('多轮：只挂到**本轮**那条 user 消息，不污染上一轮', () => {
    const s = useAgentStore()
    s.addUserMessage('第一轮', { selectionNodeIds: ['a'] })
    s.startAssistantMessage()
    s.addUserMessage('第二轮', { selectionNodeIds: ['b'] })
    s.startAssistantMessage()
    s.confirmSelectionBinding([{ id: 'b', type: 'prompt', title: '第3镜' }])
    expect(s.messages[0].selectionBindingConfirmed).toBeUndefined()
    expect(s.messages[2].selectionBindingConfirmed).toHaveLength(1)
  })

  it('没有 user 消息时收到确认 ⇒ 静默忽略（不得凭空造消息）', () => {
    const s = useAgentStore()
    s.confirmSelectionBinding([{ id: 'a', type: 'image', title: 'T' }])
    expect(s.messages).toHaveLength(0)
  })

  it('存的是副本：外部数组后续改动不影响已确认内容', () => {
    const s = useAgentStore()
    s.addUserMessage('hi', { selectionNodeIds: ['a'] })
    const nodes = [{ id: 'a', type: 'image', title: 'T' }]
    s.confirmSelectionBinding(nodes)
    nodes.push({ id: 'b', type: 'prompt', title: 'X' })
    expect(s.messages[0].selectionBindingConfirmed).toHaveLength(1)
  })
})
