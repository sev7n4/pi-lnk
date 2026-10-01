import { describe, expect, it } from 'vitest'
import { resolveProposeCancelNodeId } from './proposeWaitActions'

describe('proposeWait 取消按钮（2026-10-01）', () => {
  it('有 nodeId 才允许取消', () => {
    expect(resolveProposeCancelNodeId({ toolName: 'propose_generation', nodeId: 'prompt-1' })).toBe(
      'prompt-1',
    )
    expect(resolveProposeCancelNodeId({ toolName: 'propose_generation' })).toBeNull()
    expect(resolveProposeCancelNodeId(null)).toBeNull()
  })

  it('非 propose 工具的阻塞等待不给取消入口', () => {
    expect(resolveProposeCancelNodeId({ toolName: 'ask_user', nodeId: 'x' })).toBeNull()
  })
})
