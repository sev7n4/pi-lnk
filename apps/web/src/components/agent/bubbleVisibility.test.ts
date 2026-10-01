import { describe, expect, it } from 'vitest'
import type { AgentStreamMessage } from '@/stores/agent'
import { hasBubbleContent } from '@/components/agent/bubbleVisibility'

function assistant(content: string, streaming = false) {
  return { id: 'a1', role: 'assistant', content, streaming } as AgentStreamMessage
}

function user(content: string) {
  return { id: 'u1', role: 'user', content } as AgentStreamMessage
}

describe('hasBubbleContent（P0：零内容不渲染白块）', () => {
  it('流式但零内容（阻塞等待期典型现场）→ false', () => {
    expect(hasBubbleContent(assistant('', true))).toBe(false)
  })
  it('流式且已有 token → true', () => {
    expect(hasBubbleContent(assistant('起', true))).toBe(true)
  })
  it('非流式无内容 → false', () => {
    expect(hasBubbleContent(assistant(''))).toBe(false)
  })
  it('助手纯机器载荷 → false', () => {
    expect(hasBubbleContent(assistant('__new_task__'))).toBe(false)
  })
  it('用户纯机器载荷 → false', () => {
    expect(hasBubbleContent(user('__scheme_decision__'))).toBe(false)
  })
  it('用户正常消息 → true', () => {
    expect(hasBubbleContent(user('画只卡通小狗'))).toBe(true)
  })
})
