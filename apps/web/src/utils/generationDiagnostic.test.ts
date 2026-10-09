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

// 回归锁：模型被静默换成默认模型时照扣费（生产 1206 笔 completed 且
// originalModel != modelKey），`modelFallback` 只写进 metadata、前端零渲染
// ⇒ 用户选了 Seedance、实际拿到 Agnes，全程不知情。
// 与 droppedFields 同构：成功态也要让用户看见「能力被替换」。
describe('modelFallback 暴露被替换的模型', () => {
  const meta = (extra: Record<string, unknown>) =>
    JSON.stringify({ modelFallback: true, ...extra })

  it('names both the requested and the dispatched model on a SUCCESSFUL record', () => {
    // 生产真实降级样本：选了 Seedance、实际生成 Agnes
    const msg = getRecordFailureMessage({
      status: 'completed',
      metadata: meta({
        originalModel: 'seedance-2.0-mini',
        gatewayModelId: 'agnes-video-v2.0',
      }),
    })
    expect(msg).toContain('seedance-2.0-mini')
    expect(msg).toContain('agnes-video-v2.0')
    expect(msg).toMatch(/不可用|默认模型|替换/)
  })

  it('STAYS SILENT when the dispatched model equals the requested one', () => {
    expect(
      getRecordFailureMessage({
        status: 'completed',
        metadata: meta({
          originalModel: 'agnes-video-v2.0',
          gatewayModelId: 'agnes-video-v2.0',
        }),
      }),
    ).toBeNull()
  })

  it('STAYS SILENT for the 1196 BYOK records whose modelKey merely differs in naming', () => {
    // 生产最大的一类。⚠️ 此样本里 `gatewayModelId` 与 `modelId` 互相矛盾
    // （2.1 vs 2.0），真正投递的是 `modelId`（studio.service.ts:1171）。
    // 若先读 gatewayModelId，这1196 笔全部会被误报成降级。
    expect(
      getRecordFailureMessage({
        status: 'completed',
        metadata: meta({
          originalModel: 'cmrrwoqwz0005ql018ps94tid::agnes-image-2.0-flash',
          modelKey: 'agnes-image-2.1-flash',
          gatewayModelId: 'agnes-image-2.1-flash',
          modelId: 'agnes-image-2.0-flash',
          nativeParams: { model: 'agnes-image-2.1-flash' },
        }),
      }),
    ).toBeNull()
  })

  it('reports a BYOK swap when the dispatched id really differs', () => {
    const msg = getRecordFailureMessage({
      status: 'completed',
      metadata: meta({
        originalModel: 'cmrrwoqwz0005ql018ps94tid::agnes-image-2.0-flash',
        modelId: 'agnes-image-2.1-flash',
      }),
    })
    expect(msg).toContain('agnes-image-2.0-flash')
    expect(msg).toContain('agnes-image-2.1-flash')
    // 渠道前缀 userId:: 不该出现在给用户看的文案里
    expect(msg).not.toContain('cmrrwoqwz')
  })

  it('STAYS SILENT when no dispatched id can be found', () => {
    // 只有 flag 与 modelKey、但没有 gatewayModelId/modelId ⇒
    // 无法证明换了模型，不提示。
    expect(
      getRecordFailureMessage({
        status: 'completed',
        metadata: meta({ originalModel: 'seedance-2.0-mini', modelKey: 'agnes-video-v2.0' }),
      }),
    ).toBeNull()
    expect(getRecordFailureMessage({ status: 'completed', metadata: meta({}) })).toBeNull()
  })

  it('tolerates the legacy boolean-only metadata shape', () => {
    expect(getRecordFailureMessage({ status: 'completed', metadata: '{"modelFallback":true}' })).toBeNull()
  })

  it('is ignored when the flag is absent or falsy', () => {
    expect(
      getRecordFailureMessage({
        status: 'completed',
        metadata: JSON.stringify({
          originalModel: 'a',
          gatewayModelId: 'b',
        }),
      }),
    ).toBeNull()
    expect(
      getRecordFailureMessage({
        status: 'completed',
        metadata: JSON.stringify({
          modelFallback: false,
          originalModel: 'a',
          gatewayModelId: 'b',
        }),
      }),
    ).toBeNull()
  })

  it('combines with the dropped-params notice and prefers a real failure message', () => {
    const combined = getRecordFailureMessage({
      status: 'completed',
      metadata: meta({
        originalModel: 'seedance-2.0-mini',
        gatewayModelId: 'agnes-video-v2.0',
        droppedFields: [{ field: 'crop', reason: 'x' }],
      }),
    })
    expect(combined).toMatch(/不可用|默认模型|替换/)
    expect(combined).toContain('裁切')

    const failed = getRecordFailureMessage({
      status: 'failed',
      metadata: meta({
        originalModel: 'seedance-2.0-mini',
        gatewayModelId: 'agnes-video-v2.0',
        userMessage: '上游 503',
      }),
    })
    expect(failed).toBe('上游 503')
  })
})
