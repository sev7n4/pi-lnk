import { describe, expect, it } from 'vitest'
import { nodeHasUsableOutput, shouldApplyGenerationPoll } from './generationPollGate'

describe('shouldApplyGenerationPoll', () => {
  it('applies terminal result when node already error but same recordId', () => {
    expect(
      shouldApplyGenerationPoll({
        nodeStatus: 'error',
        nodeRecordId: 'rec-1',
        incomingRecordId: 'rec-1',
        incomingStatus: 'failed',
      }),
    ).toBe(true)
  })

  it('ignores stale record when node tracks a newer id', () => {
    expect(
      shouldApplyGenerationPoll({
        nodeStatus: 'generating',
        nodeRecordId: 'rec-2',
        incomingRecordId: 'rec-1',
        incomingStatus: 'completed',
      }),
    ).toBe(false)
  })

  it('rejects newer completed id while node still points at older failed id', () => {
    // Repro: text/prompt/audio forgot to bump generationRecordId before resolve.
    expect(
      shouldApplyGenerationPoll({
        nodeStatus: 'generating',
        nodeRecordId: 'cmrxhe8sk005kny01qbl02zky',
        incomingRecordId: 'cmrxhfe7m005ony013k0s8mxm',
        incomingStatus: 'completed',
      }),
    ).toBe(false)
  })

  it('ignores writes after cancel to draft', () => {
    expect(
      shouldApplyGenerationPoll({
        nodeStatus: 'draft',
        nodeRecordId: 'rec-1',
        incomingRecordId: 'rec-1',
        incomingStatus: 'completed',
      }),
    ).toBe(false)
  })

  it('rejects fallback_pending overwrite after local error cancel', () => {
    expect(
      shouldApplyGenerationPoll({
        nodeStatus: 'error',
        nodeRecordId: 'rec-1',
        incomingRecordId: 'rec-1',
        incomingStatus: 'fallback_pending',
      }),
    ).toBe(false)
  })

  it('still applies failed terminal after error for same recordId', () => {
    expect(
      shouldApplyGenerationPoll({
        nodeStatus: 'error',
        nodeRecordId: 'rec-1',
        incomingRecordId: 'rec-1',
        incomingStatus: 'failed',
      }),
    ).toBe(true)
  })
})

describe('nodeHasUsableOutput', () => {
  it('图片节点已有 images 数组 ⇒ 视为有产物', () => {
    expect(nodeHasUsableOutput({ images: ['https://x/a.png'] })).toBe(true)
  })

  it('images 数组为空但 url 存在 ⇒ 视为有产物', () => {
    expect(nodeHasUsableOutput({ images: [], url: 'https://x/a.png' })).toBe(true)
  })

  it('images 里只有空串 ⇒ 不算产物', () => {
    expect(nodeHasUsableOutput({ images: [''] })).toBe(false)
  })

  it('既无 images 也无 url ⇒ 无产物', () => {
    expect(nodeHasUsableOutput({ status: 'generating' })).toBe(false)
  })

  it('data 为空 / 非对象 ⇒ 无产物（不抛错）', () => {
    expect(nodeHasUsableOutput(undefined)).toBe(false)
    expect(nodeHasUsableOutput(null)).toBe(false)
    expect(nodeHasUsableOutput('x')).toBe(false)
  })

  it('text 节点的 content 不属于本函数判定范围', () => {
    expect(nodeHasUsableOutput({ content: '一段文本' })).toBe(false)
  })
})
