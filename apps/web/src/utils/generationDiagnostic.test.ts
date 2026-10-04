import { describe, expect, it, vi } from 'vitest'
import { NODE_GENERATION_STATUS } from '@/constants/dockStudio'
import {
  buildCopyForNode,
  buildPollingFailurePatch,
  createDiagnosticCache,
  describeDroppedFields,
  getRecordFailureMessage,
  parseErrorCodeFromMetadata,
  parseShortGenerationError,
} from './generationDiagnostic'

describe('parseShortGenerationError', () => {
  it('reads structured body', () => {
    const parsed = parseShortGenerationError({
      response: {
        data: {
          message: '上游超时',
          errorCode: 'upstream_timeout',
          taskKind: 'generation',
          taskId: 'g1',
        },
      },
    })
    expect(parsed).toMatchObject({
      userMessage: '上游超时',
      errorCode: 'upstream_timeout',
      taskId: 'g1',
    })
  })

  it('falls back to formatGenerationFailureMessage for legacy errors', () => {
    const parsed = parseShortGenerationError({
      response: { data: { message: '积分不足' } },
    })
    expect(parsed.userMessage).toBe('积分不足，请充值后再试')
    expect(parsed.errorCode).toBeUndefined()
  })

  it('reads refundedPoints from structured body', () => {
    const parsed = parseShortGenerationError({
      response: {
        data: {
          message: '已取消',
          refundedPoints: 8,
        },
      },
    })
    expect(parsed).toMatchObject({
      userMessage: '已取消，8 积分已返回',
      refundedPoints: 8,
    })
  })
})

describe('parseErrorCodeFromMetadata', () => {
  it('reads valid errorCode from metadata JSON', () => {
    expect(
      parseErrorCodeFromMetadata(JSON.stringify({ errorCode: 'upstream_timeout' })),
    ).toBe('upstream_timeout')
  })

  it('returns undefined for missing or invalid metadata', () => {
    expect(parseErrorCodeFromMetadata(null)).toBeUndefined()
    expect(parseErrorCodeFromMetadata('{')).toBeUndefined()
    expect(parseErrorCodeFromMetadata(JSON.stringify({ errorCode: 'nope' }))).toBeUndefined()
  })
})

describe('buildPollingFailurePatch', () => {
  it('persists generationRecordId and errorCode from studio metadata', () => {
    expect(
      buildPollingFailurePatch({
        metadata: JSON.stringify({ errorCode: 'upstream_timeout', refundedPoints: 5 }),
        generationRecordId: 'rec-1',
      }),
    ).toEqual({
      status: NODE_GENERATION_STATUS.error,
      errorMessage: '生成失败，5 积分已返回',
      generationRecordId: 'rec-1',
      errorCode: 'upstream_timeout',
    })
  })

  it('persists materialId on shot/material failures', () => {
    expect(
      buildPollingFailurePatch({
        metadata: JSON.stringify({ errorCode: 'upstream_error' }),
        materialId: 'mat-1',
      }),
    ).toEqual({
      status: NODE_GENERATION_STATUS.error,
      errorMessage: '生成失败',
      materialId: 'mat-1',
      errorCode: 'upstream_error',
    })
  })

  it('omits errorCode when metadata has none', () => {
    const patch = buildPollingFailurePatch({
      generationRecordId: 'rec-2',
    })
    expect(patch).toEqual({
      status: NODE_GENERATION_STATUS.error,
      errorMessage: '生成失败',
      generationRecordId: 'rec-2',
    })
    expect(patch).not.toHaveProperty('errorCode')
  })
})

describe('buildCopyForNode', () => {
  it('buildCopyForNode merges node context', () => {
    const text = buildCopyForNode(
      {
        userMessage: 'x',
        code: 'unknown',
        taskKind: 'generation',
        taskId: 'g1',
        occurredAt: 't',
        providerSnippet: null,
      },
      { nodeId: 'n1', nodeLabel: '文本', sessionId: 's1' },
    )
    expect(text).toContain('nodeId: n1')
    expect(text).toContain('sessionId: s1')
  })
})

describe('createDiagnosticCache', () => {
  it('dedupes in-flight fetches', async () => {
    const cache = createDiagnosticCache()
    const fetcher = vi.fn().mockResolvedValue({ taskId: 'g1', code: 'unknown' })
    const a = cache.get('generation', 'g1', fetcher)
    const b = cache.get('generation', 'g1', fetcher)
    await Promise.all([a, b])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retries after fetch rejection', async () => {
    const cache = createDiagnosticCache()
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ taskId: 'g1', code: 'unknown' })

    await expect(cache.get('generation', 'g1', fetcher)).rejects.toThrow('network')
    const result = await cache.get('generation', 'g1', fetcher)
    expect(result).toEqual({ taskId: 'g1', code: 'unknown' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('clears by taskId', async () => {
    const cache = createDiagnosticCache()
    const fetcher = vi.fn().mockResolvedValue({ taskId: 'g1', code: 'unknown' })
    await cache.get('generation', 'g1', fetcher)
    cache.clear('g1')
    await cache.get('generation', 'g1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

// 回归锁：droppedFields 只写进 metadata，前端零渲染 —— 用户在 UI 上点了
// 「生成带音轨视频」，模型不支持时毫无反馈也没报错（生产 Agnes 335 次诚实丢弃
// + Seedance 16 次误丢，用户全都看不见）。
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.3
describe('getRecordFailureMessage 暴露被丢弃的参数', () => {
  it('surfaces dropped params on a SUCCESSFUL record', () => {
    const msg = getRecordFailureMessage({ status: 'completed',
      metadata: JSON.stringify({
        droppedFields: [
          { field: 'generateAudio', reason: 'generateAudio not supported natively by agnes-video-v2.0' },
        ],
      }),
    })
    expect(msg).toContain('音轨')
    expect(msg).toContain('当前模型不支持')
  })

  it('dedupes and localises multiple dropped fields, keeping unknown field names', () => {
    const msg = getRecordFailureMessage({ status: 'completed',
      metadata: JSON.stringify({
        droppedFields: [
          { field: 'generateAudio', reason: 'x' },
          { field: 'generateAudio', reason: 'y' },
          { field: 'seed', reason: 'z' },
          { field: 'someBrandNewField', reason: 'w' },
        ],
      }),
    })
    // generateAudio 出现两次只算一次
    expect(msg?.match(/音轨/g)).toHaveLength(1)
    expect(msg).toContain('随机种子')
    // 未登记的字段名直接透出，不被吞掉
    expect(msg).toContain('someBrandNewField')
  })

  it('returns null on success when nothing was dropped', () => {
    expect(
      getRecordFailureMessage({ status: 'completed',
        metadata: JSON.stringify({ droppedFields: [] }),
      }),
    ).toBeNull()
  })

  it('still prefers the real failure message on a FAILED record', () => {
    const msg = getRecordFailureMessage({ status: 'failed',
      metadata: JSON.stringify({
        userMessage: '上游 503',
        droppedFields: [{ field: 'generateAudio', reason: 'x' }],
      }),
    })
    expect(msg).toBe('上游 503')
  })

  it('tolerates malformed metadata and non-array droppedFields', () => {
    expect(
      getRecordFailureMessage({ status: 'completed', metadata: '{',
      }),
    ).toBeNull()
    expect(
      getRecordFailureMessage({ status: 'completed',
        metadata: JSON.stringify({ droppedFields: 'not-an-array' }),
      }),
    ).toBeNull()
    expect(
      getRecordFailureMessage({ status: 'completed',
        metadata: JSON.stringify({ droppedFields: [{ reason: 'no field key' }] }),
      }),
    ).toBeNull()
  })
})

describe('describeDroppedFields', () => {
  it('returns null for empty / non-array input', () => {
    expect(describeDroppedFields(undefined)).toBeNull()
    expect(describeDroppedFields([])).toBeNull()
    expect(describeDroppedFields('x' as never)).toBeNull()
  })

  it('lists labels joined by 、 in first-seen order', () => {
    expect(
      describeDroppedFields([{ field: 'seed' }, { field: 'generateAudio' }]),
    ).toBe('以下参数当前模型不支持，已忽略：随机种子、音轨')
  })
})
