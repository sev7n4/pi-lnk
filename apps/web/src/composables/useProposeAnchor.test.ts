import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isPartAnchoredNode } from './useProposeAnchor'
import { useAgentStore } from '@/stores/agent'

describe('isPartAnchoredNode：proposal part 锚定判定（P0-2）', () => {
  it('无 nodeId → false（不触 store）', () => {
    setActivePinia(createPinia())
    expect(isPartAnchoredNode(null)).toBe(false)
    expect(isPartAnchoredNode(undefined)).toBe(false)
    expect(isPartAnchoredNode('')).toBe(false)
  })

  it('有活跃 pending proposal 且 nodeId 匹配 → true；不匹配 → false', () => {
    setActivePinia(createPinia())
    const agent = useAgentStore()
    // 直接注入一条 pending proposal 时间线消息（waiting_user 事件收敛形态）
    agent.messages.push({
      id: 'm1',
      role: 'assistant',
      content: '',
      timeline: {
        parts: [
          {
            kind: 'proposal',
            status: 'pending_confirm',
            callId: 'tc-1',
            nodeId: 'n1',
            startedAt: Date.now(),
          },
        ],
      },
    } as never)
    expect(isPartAnchoredNode('n1')).toBe(true)
    expect(isPartAnchoredNode('n2')).toBe(false)
  })

  it('无 active pinia（测试环境）→ 安全 false，不抛错', () => {
    // 显式清掉上一用例的 active pinia —— 模拟展示组件直 mount 的测试环境
    setActivePinia(undefined as never)
    expect(() => isPartAnchoredNode('n1')).not.toThrow()
    expect(isPartAnchoredNode('n1')).toBe(false)
  })
})
