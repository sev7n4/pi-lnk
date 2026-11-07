import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const trackWaitingUser = vi.fn()
const resolveQuestionPart = vi.fn()
let pendingProposal: any = null
vi.mock('@/stores/agent', () => ({
  useAgentStore: () => ({
    get pendingProposal() {
      return pendingProposal
    },
    trackWaitingUser,
    resolveQuestionPart,
  }),
}))

const submitAnswers = vi.fn()
vi.mock('@/components/agent/agentAnswers', () => ({
  submitAnswers: (...args: any[]) => submitAnswers(...args),
}))

const elError = vi.fn()
vi.mock('element-plus', () => ({
  ElMessage: { error: (...a: any[]) => elError(...a) },
}))

vi.mock('@/components/agent/proposeWaitActions', () => ({
  resolveProposeCancelCallId: () =>
    pendingProposal && pendingProposal.toolName === 'propose_generation' ? 'call-x' : undefined,
  resolveProposeCancelNodeId: () =>
    pendingProposal && pendingProposal.toolName === 'propose_generation' ? 'node-x' : undefined,
  resolveProposeConfirmCallId: () => (pendingProposal ? 'call-y' : undefined),
}))

import { useAgentPropose } from './useAgentPropose'

describe('useAgentPropose', () => {
  let sendMessage: any
  let emit: any
  let answersPost: any

  beforeEach(() => {
    pendingProposal = null
    trackWaitingUser.mockClear()
    resolveQuestionPart.mockClear()
    submitAnswers.mockReset()
    elError.mockClear()
    sendMessage = vi.fn().mockResolvedValue(undefined)
    emit = vi.fn()
    answersPost = vi.fn()
  })

  function make() {
    return useAgentPropose({
      agentThreadId: ref('thread-1'),
      sessionId: 'sess-1',
      emit,
      sendMessage,
      answersPost,
    })
  }

  it('confirmProposeWait returns false when no pendingProposal', async () => {
    const p = make()
    expect(await p.confirmProposeWait('n1')).toBe(false)
    expect(submitAnswers).not.toHaveBeenCalled()
  })

  it('cancelProposeForNode returns false when no pendingProposal', async () => {
    const p = make()
    expect(await p.cancelProposeForNode('n1')).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('cancelProposeForNode returns false for non-propose toolName', async () => {
    pendingProposal = { toolName: 'other_tool' }
    const p = make()
    expect(await p.cancelProposeForNode('n1')).toBe(false)
  })

  it('confirmProposeWait happy path posts answers and settles', async () => {
    pendingProposal = { toolName: 'propose_generation', callId: 'c1', nodeId: 'n1' }
    submitAnswers.mockResolvedValue({ expired: false })
    const p = make()
    expect(await p.confirmProposeWait('n1')).toBe(true)
    expect(submitAnswers).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1', sessionId: 'sess-1', callId: 'call-y', answers: {} }),
      answersPost,
    )
    expect(trackWaitingUser).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved', toolName: 'propose_generation', callId: 'call-y', reason: 'answered' }),
    )
  })

  it('confirmProposeWait is idempotent within the same instance (settled no-op)', async () => {
    pendingProposal = { toolName: 'propose_generation', callId: 'c1', nodeId: 'n1' }
    submitAnswers.mockResolvedValue({ expired: false })
    const p = make()
    expect(await p.confirmProposeWait('n1')).toBe(true)
    expect(await p.confirmProposeWait('n1')).toBe(false) // second call hits settled set
    expect(submitAnswers).toHaveBeenCalledTimes(1)
  })

  it('cancelProposeForNode emits clearProposeGeneration after settle', async () => {
    pendingProposal = { toolName: 'propose_generation' }
    submitAnswers.mockResolvedValue({ expired: false })
    const p = make()
    expect(await p.cancelProposeForNode('node-x')).toBe(true)
    expect(emit).toHaveBeenCalledWith('clearProposeGeneration', 'node-x')
    expect(trackWaitingUser).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'aborted' }),
    )
  })

  it('onAskSubmit without callId falls back to sendMessage(取消)', async () => {
    const p = make()
    await p.onAskSubmit(undefined, { answers: {} })
    expect(sendMessage).toHaveBeenCalledWith('取消')
    expect(submitAnswers).not.toHaveBeenCalled()
  })

  it('onAskCancel without callId falls back to sendMessage(取消)', async () => {
    const p = make()
    await p.onAskCancel(undefined)
    expect(sendMessage).toHaveBeenCalledWith('取消')
    expect(submitAnswers).not.toHaveBeenCalled()
  })

  it('onAskSubmit with callId resolves part and submits answers', async () => {
    submitAnswers.mockResolvedValue({ deduped: false })
    const p = make()
    await p.onAskSubmit('call-1', { answers: { q1: ['a'] } })
    expect(resolveQuestionPart).toHaveBeenCalledWith('call-1', 'answered')
    expect(submitAnswers).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1', sessionId: 'sess-1', callId: 'call-1', answers: { q1: ['a'] } }),
      answersPost,
    )
  })

  it('onAskCancel with callId declines and submits empty answers', async () => {
    submitAnswers.mockResolvedValue({ deduped: false })
    const p = make()
    await p.onAskCancel('call-2')
    expect(resolveQuestionPart).toHaveBeenCalledWith('call-2', 'declined')
    expect(submitAnswers).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-2', answers: {} }),
      answersPost,
    )
  })
})
