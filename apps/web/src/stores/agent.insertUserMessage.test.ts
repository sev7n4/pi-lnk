// `insertUserMessageBeforeAssistant`（2026-10-21 回归锁）。
//
// 用途：插话被模型消费时补建用户气泡。落点必须与正常发送一致 ——
// 用户的插话出现在**模型回答之前**，而不是被塞到回答后面。
//
// 为什么不能直接用 `addUserMessage`（两条独立的不变量）：
//  ① 它 push 到**末尾** —— 流式中 assistant 气泡已存在且持续累积正文，
//     追加到末尾会让用户气泡排到 assistant 之后（顺序错乱）。
//  ② 它会**重置回合级瞬态**（propose 等待 / recovering / turnError /
//     turnRefusal）—— 插话发生在本轮中途，重置等于把本轮的阻塞等待与失败态抹掉。
//     （propose 等待现已收敛进时间线 proposal part，单一真相，无并行 store 镜像。）
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from '@/stores/agent'

describe('insertUserMessageBeforeAssistant', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('插到最后一条 assistant 消息**之前**（用户的话在模型回答前面）', () => {
    const agent = useAgentStore()
    agent.addUserMessage('第一句')
    agent.startAssistantMessage()
    agent.appendText('模型正在说的话')

    agent.insertUserMessageBeforeAssistant('插话补充', { entryId: 'e-1' })

    const roles = agent.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'user', 'assistant'])
    expect(agent.messages[1]?.content).toBe('插话补充')
    expect(agent.messages[1]?.entryId).toBe('e-1')
    // 原来的 assistant 气泡仍是最后一条，正文不受影响
    expect(agent.messages[2]?.content).toBe('模型正在说的话')
  })

  it('没有 assistant 气泡时退化为追加到末尾', () => {
    const agent = useAgentStore()
    agent.addUserMessage('第一句')

    agent.insertUserMessageBeforeAssistant('插话补充', { entryId: 'e-2' })

    expect(agent.messages.map((m) => m.content)).toEqual(['第一句', '插话补充'])
  })

  it('⭐ 不重置回合级瞬态（插话发生在本轮中途）', () => {
    const agent = useAgentStore()
    agent.addUserMessage('第一句')
    agent.startAssistantMessage()
    // 等待态单一真相：时间线 pending_confirm proposal part（取代旧 blockingWait 镜像）
    agent.trackWaitingUser({ status: 'waiting', toolName: 'propose_generation', callId: 'call-1', nodeId: 'node-1' })
    agent.markTurnError(new Error('上游超时'))
    agent.setRecovering(true)

    agent.insertUserMessageBeforeAssistant('插话补充', { entryId: 'e-3' })

    // 时间线等待态不被插话抹掉（pendingProposal 派生自时间线，与对话流/状态行同源）
    expect(agent.pendingProposal?.callId).toBe('call-1')
    expect(agent.turnError).toBeInstanceOf(Error)
    expect(agent.recovering).toBe(true)
  })

  it('⭐ 连续插入的消息 id 不撞（v-for 的 :key 依赖唯一）', () => {
    const agent = useAgentStore()
    agent.startAssistantMessage()

    agent.insertUserMessageBeforeAssistant('甲')
    agent.insertUserMessageBeforeAssistant('乙')

    const ids = agent.messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('素材与选中态随消息带出（与正常发送同口径）', () => {
    const agent = useAgentStore()
    agent.startAssistantMessage()

    agent.insertUserMessageBeforeAssistant('带素材的插话', {
      entryId: 'e-4',
      attachments: [
        {
          id: 'a1',
          mediaType: 'image',
          sourceKind: 'upload',
          label: '参考图',
          url: 'https://example.com/a1.png',
          role: 'product',
        },
      ],
      selectionNodeIds: ['n1', 'n2'],
    })

    const inserted = agent.messages.find((m) => m.content === '带素材的插话')
    expect(inserted?.attachments).toHaveLength(1)
    expect(inserted?.selectionNodeIds).toEqual(['n1', 'n2'])
  })
})
