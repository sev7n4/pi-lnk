import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentChatMessage, SidebarAttachment } from '@lnkpi/shared'
import { useAgentStore } from './agent'
import { useAuthStore } from './auth'

type PersistedAgentMessage = AgentChatMessage & { linkedOutputs?: string }

describe('useAgentStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('preserves an attachment snapshot on user messages', () => {
    const store = useAgentStore()
    const attachments: SidebarAttachment[] = [
      {
        id: 'attachment-1',
        mediaType: 'image',
        sourceKind: 'upload',
        label: 'product.png',
        url: 'https://cdn.example.com/product.png',
      },
    ]

    store.addUserMessage('参考这张图生成海报', {
      attachments,
      attachmentRefKeys: ['I1'],
    })
    attachments[0].label = 'changed.png'

    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '参考这张图生成海报',
        attachments: [
          expect.objectContaining({ label: 'product.png' }),
        ],
        attachmentRefKeys: ['I1'],
      }),
    ])
  })

  it('restores persisted attachment snapshots from message history', () => {
    const store = useAgentStore()
    const attachments: SidebarAttachment[] = [
      {
        id: 'attachment-1',
        mediaType: 'image',
        sourceKind: 'canvasNode',
        label: 'canvas output',
        url: 'https://cdn.example.com/output.png',
        sourceNodeId: 'image-1',
      },
    ]

    store.loadHistory([
      {
        id: 'message-1',
        sessionId: 'session-1',
        role: 'user',
        content: '用这张图继续生成',
        attachments: JSON.stringify(attachments),
        createdAt: '2026-08-07T00:00:00.000Z',
      },
    ])

    expect(store.messages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        attachments,
      }),
    ])
  })

  it('restores persisted linkedOutputs from message history', () => {
    const store = useAgentStore()
    const linkedOutputs = [
      {
        nodeId: 'image-1',
        title: '主图',
        nodeType: 'image',
        status: 'done' as const,
      },
    ]

    store.loadHistory([
      {
        id: 'message-1',
        sessionId: 'session-1',
        role: 'assistant',
        content: '已生成主图',
        linkedOutputs: JSON.stringify(linkedOutputs),
        createdAt: '2026-08-07T00:00:00.000Z',
      } satisfies PersistedAgentMessage,
    ])

    expect(store.messages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        role: 'assistant',
        linkedOutputs,
      }),
    ])
  })

  it('replaces existing messages when loading history', () => {
    const store = useAgentStore()
    store.addUserMessage('old message')

    store.loadHistory([
      {
        id: 'message-2',
        sessionId: 'session-1',
        role: 'user',
        content: 'new message',
        createdAt: '2026-08-07T00:00:00.000Z',
      },
    ])

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toEqual(
      expect.objectContaining({
        id: 'message-2',
        content: 'new message',
      }),
    )
  })
})

describe('canvas_action 流内实时上屏（2026-10-01）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('addCanvasAction 只记录 trace，不再积压 pendingActions / flushActions 通道', () => {
    const store = useAgentStore()
    store.startAssistantMessage()
    const action = {
      type: 'add_node',
      payload: { id: 'prompt-1', nodeType: 'prompt', position: { x: 0, y: 0 }, data: {} },
    } as unknown as Parameters<typeof store.addCanvasAction>[0]

    store.addCanvasAction(action)

    // trace 照记（执行过程可见性不回退）
    const last = store.messages[store.messages.length - 1]
    expect(last?.executionTrace).toBeTruthy()
    // 积压通道废除：flushActions / pendingActions 不再暴露（上屏责任移交流内 emit）
    expect((store as unknown as Record<string, unknown>).flushActions).toBeUndefined()
    expect((store as unknown as Record<string, unknown>).pendingActions).toBeUndefined()
  })
})

describe('trackTurnSettled（P2 T7）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('live 通道：settled 数据落最近 assistant 消息 trace + 触发 auth.refreshPoints', async () => {
    const auth = useAuthStore()
    const refreshSpy = vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.startAssistantMessage()
    store.trackTurnUsage({ inputTokens: 3000, outputTokens: 400, estimatedCredits: 8 })
    store.trackTurnSettled({ holdId: 'h1', credits: 8, breakdown: { in: 3000, cache: 0, out: 400 } })

    const last = store.messages[store.messages.length - 1]
    expect(last?.executionTrace?.settled).toEqual({
      holdId: 'h1',
      credits: 8,
      breakdown: { in: 3000, cache: 0, out: 400 },
    })
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('released 形态：settled.released 落 trace，不抛错', () => {
    const auth = useAuthStore()
    vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.startAssistantMessage()
    expect(() =>
      store.trackTurnSettled({ holdId: 'h2', released: true }),
    ).not.toThrow()
    const last = store.messages[store.messages.length - 1]
    expect(last?.executionTrace?.settled).toEqual({ holdId: 'h2', released: true })
  })

  it('重放通道：loadHistory 的 executionEvents 含 turn_settled → settled 还原到 trace + 触发 refreshPoints', async () => {
    const auth = useAuthStore()
    const refreshSpy = vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.loadHistory([
      {
        id: 'message-9',
        sessionId: 'session-1',
        role: 'assistant',
        content: '已结算回合',
        metadata: JSON.stringify({
          executionEvents: [
            { type: 'turn_usage', data: { inputTokens: 3000, outputTokens: 400, estimatedCredits: 8 } },
            { type: 'turn_settled', data: { holdId: 'h3', credits: 8, breakdown: { in: 3000, cache: 0, out: 400 } } },
          ],
        }),
        createdAt: '2026-10-15T00:00:00.000Z',
      } as unknown as AgentChatMessage,
    ])

    const restored = store.messages[0]
    expect(restored?.executionTrace?.settled).toEqual({
      holdId: 'h3',
      credits: 8,
      breakdown: { in: 3000, cache: 0, out: 400 },
    })
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('重放通道：历史无 turn_settled → 不触发 refreshPoints（回归不变）', () => {
    const auth = useAuthStore()
    const refreshSpy = vi.spyOn(auth, 'refreshPoints').mockResolvedValue(100)
    const store = useAgentStore()
    store.loadHistory([
      {
        id: 'message-10',
        sessionId: 'session-1',
        role: 'assistant',
        content: '旧回合',
        metadata: JSON.stringify({
          executionEvents: [
            { type: 'turn_usage', data: { inputTokens: 500, outputTokens: 100 } },
          ],
        }),
        createdAt: '2026-10-15T00:00:00.000Z',
      } as unknown as AgentChatMessage,
    ])
    expect(refreshSpy).not.toHaveBeenCalled()
  })
})
