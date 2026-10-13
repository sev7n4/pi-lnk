import { describe, it, expect, vi } from 'vitest'
import { emitGenerationFailure } from './emission'
import type { GenerationRecoveryService } from './generation-recovery.service'

function makeRecovery() {
  return {
    handleGenerationFailed: vi.fn(async () => ({ path: 'newTurn', reason: 'idle', briefOnly: false })),
  } as never as GenerationRecoveryService & {
    handleGenerationFailed: ReturnType<typeof vi.fn>
  }
}

const baseInput = {
  sessionId: 'sess-x',
  userId: 'user-x',
  nodeId: 'node-x',
  generationRecordId: 'rec-x',
}

function errorResult(errorMessage?: string) {
  const data: Record<string, unknown> = { status: 'error' }
  if (errorMessage) data.errorMessage = errorMessage
  return {
    status: 'error',
    generationRecordId: 'rec-x',
    actions: [{ type: 'update_node', payload: { id: 'node-x', data } }],
  } as never
}

describe('emitGenerationFailure（waitVideoGeneration 发射辅助，PR3 Task4）', () => {
  it('status=error → handleGenerationFailed 收到三要素 + actions 里的 errorMessage', () => {
    const recovery = makeRecovery()
    emitGenerationFailure(recovery, baseInput, errorResult('上游 502'))
    expect(recovery.handleGenerationFailed).toHaveBeenCalledTimes(1)
    expect(recovery.handleGenerationFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-x',
        userId: 'user-x',
        nodeId: 'node-x',
        generationRecordId: 'rec-x',
        userMessage: '上游 502',
      }),
    )
  })

  it('actions 无 errorMessage → userMessage 回落缺省文案', () => {
    const recovery = makeRecovery()
    emitGenerationFailure(recovery, baseInput, errorResult())
    expect(recovery.handleGenerationFailed).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: '视频生成失败' }),
    )
  })

  it('status=completed → 零发射', () => {
    const recovery = makeRecovery()
    emitGenerationFailure(recovery, baseInput, {
      status: 'completed',
      generationRecordId: 'rec-x',
      url: 'https://x',
      actions: [],
    } as never)
    expect(recovery.handleGenerationFailed).not.toHaveBeenCalled()
  })

  it('recovery 未注入（@Optional 缺省）→ 不抛错不发射（flag off 第二道闸）', () => {
    expect(() => emitGenerationFailure(undefined, baseInput, errorResult('x'))).not.toThrow()
  })

  it('recovery 抛错 → fail-open，不向调用方传播', async () => {
    const recovery = makeRecovery()
    recovery.handleGenerationFailed.mockRejectedValueOnce(new Error('boom'))
    expect(() => emitGenerationFailure(recovery, baseInput, errorResult('x'))).not.toThrow()
  })
})
