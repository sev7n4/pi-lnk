import { describe, expect, it } from 'vitest'
import {
  AgentConversationRequestSchema,
  AgentThreadSummarySchema,
  GetAgentMessagesQuerySchema,
  LinkedCanvasOutputSchema,
} from './agentContract'

describe('LinkedCanvasOutputSchema', () => {
  it('parses linked output', () => {
    expect(
      LinkedCanvasOutputSchema.parse({
        nodeId: 'n1',
        title: '主图',
        nodeType: 'image',
        status: 'done',
      }),
    ).toMatchObject({ nodeId: 'n1', status: 'done' })
  })

  it('rejects invalid status', () => {
    expect(() =>
      LinkedCanvasOutputSchema.parse({
        nodeId: 'n1',
        title: '主图',
        nodeType: 'image',
        status: 'pending',
      }),
    ).toThrow()
  })
})

describe('AgentThreadSummarySchema', () => {
  it('parses thread summary', () => {
    expect(
      AgentThreadSummarySchema.parse({
        id: 's1:abc',
        sessionId: 's1',
        title: '帮我生成唐朝宰相三视图',
        createdAt: '2026-08-07T10:00:00.000Z',
        updatedAt: '2026-08-07T12:00:00.000Z',
      }),
    ).toMatchObject({ id: 's1:abc', sessionId: 's1' })
  })
})

describe('GetAgentMessagesQuerySchema', () => {
  it('requires sessionId and threadId', () => {
    expect(
      GetAgentMessagesQuerySchema.parse({
        sessionId: 's1',
        threadId: 's1:abc',
      }),
    ).toMatchObject({ sessionId: 's1', threadId: 's1:abc' })
  })

  it('rejects missing threadId', () => {
    expect(() =>
      GetAgentMessagesQuerySchema.parse({
        sessionId: 's1',
      }),
    ).toThrow()
  })
})

describe('AgentConversationRequestSchema mentionedKeys', () => {
  it('accepts valid mentionedKeys', () => {
    const parsed = AgentConversationRequestSchema.parse({
      sessionId: 's1',
      message: '@I1 风格',
      mentionedKeys: ['I1', 'T2'],
    })
    expect(parsed.mentionedKeys).toEqual(['I1', 'T2'])
  })

  it('rejects invalid ref key format', () => {
    expect(() =>
      AgentConversationRequestSchema.parse({
        sessionId: 's1',
        message: 'x',
        mentionedKeys: ['image1'],
      }),
    ).toThrow()
  })
})

describe('AgentConversationRequestSchema selectedNodeIds', () => {
  it('接受字符串数组（SEL-REF 指代信号）', () => {
    const parsed = AgentConversationRequestSchema.parse({
      sessionId: 's1',
      message: '这个节点是什么',
      selectedNodeIds: ['a', 'b'],
    })
    expect(parsed.selectedNodeIds).toEqual(['a', 'b'])
  })

  it('缺省时为 undefined（不传空数组，避免与"传了但为空"混淆）', () => {
    const parsed = AgentConversationRequestSchema.parse({ sessionId: 's1', message: 'x' })
    expect(parsed.selectedNodeIds).toBeUndefined()
  })

  it('非字符串元素被拒', () => {
    expect(() =>
      AgentConversationRequestSchema.parse({
        sessionId: 's1',
        message: 'x',
        selectedNodeIds: [1],
      }),
    ).toThrow()
  })

  it('超过 200 个被拒（防滥用硬闸）', () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => `n${i}`)
    expect(() =>
      AgentConversationRequestSchema.parse({
        sessionId: 's1',
        message: 'x',
        selectedNodeIds: tooMany,
      }),
    ).toThrow()
  })
})
