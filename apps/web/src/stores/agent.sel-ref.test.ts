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
