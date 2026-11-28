import { describe, expect, it } from 'vitest'
import {
  formatDiagnosticCopy,
  redactProviderSnippet,
  mapMessageToErrorCode,
  translateUpstreamFailure,
  isVideoQueueFullError,
} from './generationDiagnostics'

describe('redactProviderSnippet', () => {
  it('redacts bearer tokens and truncates', () => {
    const raw = `Authorization: Bearer sk-live-abc123secret\nemail user@example.com\n${'x'.repeat(3000)}`
    const out = redactProviderSnippet(raw, 200)
    expect(out).not.toContain('sk-live-abc123secret')
    expect(out).not.toMatch(/user@example\.com/)
    expect(out.length).toBeLessThanOrEqual(220)
    expect(out).toContain('truncated')
  })
})

describe('formatDiagnosticCopy', () => {
  it('formats stable key lines including nodeId and taskId', () => {
    const text = formatDiagnosticCopy({
      userMessage: '上游超时',
      code: 'upstream_timeout',
      taskKind: 'generation',
      taskId: 'gen_1',
      nodeId: 'node_1',
      occurredAt: '2026-07-21T00:00:00.000Z',
      providerSnippet: 'timeout of 90000ms exceeded',
    })
    expect(text).toContain('lnkpi diagnostic')
    expect(text).toContain('code: upstream_timeout')
    expect(text).toContain('taskId: gen_1')
    expect(text).toContain('nodeId: node_1')
    expect(text).toContain('providerSnippet:')
  })

  it('S2-3: refund 三字段齐全 → refund 行 charged → refunded (reason)', () => {
    const text = formatDiagnosticCopy({
      userMessage: '生成失败',
      code: 'upstream_error',
      taskKind: 'generation',
      taskId: 'gen_1',
      occurredAt: '2026-10-10T00:00:00.000Z',
      providerSnippet: null,
      chargedPoints: 5,
      refundedPoints: 5,
      refundReason: 'platform_failed',
    })
    expect(text).toContain('refund: charged 5 → refunded 5 (platform_failed)')
  })

  it('S2-3: 仅 refundedPoints（缺 chargedPoints/refundReason）→ 退化为 refunded 段', () => {
    const text = formatDiagnosticCopy({
      userMessage: '生成失败',
      code: 'upstream_error',
      taskKind: 'generation',
      taskId: 'gen_1',
      occurredAt: '2026-10-10T00:00:00.000Z',
      providerSnippet: null,
      refundedPoints: 3,
    })
    expect(text).toContain('refund: refunded 3')
    expect(text).not.toContain('charged')
  })

  it('S2-3: 缺退款字段 / refundedPoints=0 → 不渲染 refund 行', () => {
    const base = {
      userMessage: '生成失败',
      code: 'upstream_error' as const,
      taskKind: 'generation' as const,
      taskId: 'gen_1',
      occurredAt: '2026-10-10T00:00:00.000Z',
      providerSnippet: null,
    }
    expect(formatDiagnosticCopy(base)).not.toContain('refund:')
    expect(formatDiagnosticCopy({ ...base, chargedPoints: 5, refundedPoints: 0 })).not.toContain(
      'refund:',
    )
  })
})

describe('mapMessageToErrorCode', () => {
  it('maps known phrases', () => {
    expect(mapMessageToErrorCode('积分不足')).toBe('insufficient_points')
    expect(mapMessageToErrorCode('timeout of 90000ms exceeded')).toBe('upstream_timeout')
    expect(mapMessageToErrorCode('weird')).toBe('unknown')
  })
})

describe('translateUpstreamFailure', () => {
  it('translates real-world upstream failures (2026-09-26 incidents)', () => {
    expect(
      translateUpstreamFailure(
        'Segment API 403: {"detail":"User is locked. Reason: TOP_UP."}',
      ),
    ).toBe('上游生成服务账户已被锁定（欠费），请联系管理员充值后重试')
    expect(
      translateUpstreamFailure(
        'Image edit API 402: {"error":{"message":"[token_id=90701] insufficient balance (current: 0.013570 USD, required: 0.050000 USD)"}}',
      ),
    ).toBe('上游生成服务余额不足，请联系管理员充值后重试')
    expect(translateUpstreamFailure('fetch failed')).toBe(
      '无法连接上游生成服务（网络异常），请稍后重试',
    )
  })

  it('translates auth and rate-limit failures', () => {
    expect(translateUpstreamFailure('Image API 401: unauthorized')).toBe(
      '上游生成服务鉴权失败，请检查服务配置',
    )
    expect(translateUpstreamFailure('Image API 429: too many requests')).toBe(
      '上游生成服务限流，请稍后重试',
    )
  })

  it('returns undefined for ordinary errors so callers keep their fallback copy', () => {
    expect(translateUpstreamFailure('Image edit API returned no urls')).toBeUndefined()
    expect(translateUpstreamFailure('')).toBeUndefined()
  })
})

describe('mapMessageToErrorCode · rate_limited（信号层 P1 配套工单，spec §6）', () => {
  it('429 状态码文本 → rate_limited（生产病例：agnes hub 免费档 429）', () => {
    expect(mapMessageToErrorCode('agnes hub: 429 Too Many Requests, please retry later')).toBe('rate_limited')
  })

  it('中文限流文案 → rate_limited', () => {
    expect(mapMessageToErrorCode('429: 您已达到免费用户的 API 速率限制')).toBe('rate_limited')
  })

  it('rate limit / too many requests 无状态码形态 → rate_limited', () => {
    expect(mapMessageToErrorCode('Video API rate limit exceeded')).toBe('rate_limited')
    expect(mapMessageToErrorCode('Image API: too many requests')).toBe('rate_limited')
  })

  it('优先级保持：timeout+429 混合文本仍归 upstream_timeout（vendor 分类器看全文判可重试）', () => {
    expect(mapMessageToErrorCode('timeout waiting, then 429')).toBe('upstream_timeout')
  })

  it('订阅型配额错误（GoUsageLimitError）不误判 → 保持 unknown（vendor 非重试模式在信号层兜底）', () => {
    expect(mapMessageToErrorCode('GoUsageLimitError: free tier quota exhausted')).toBe('unknown')
  })
})

describe('mapMessageToErrorCode · video_queue_full（2026-11-28 生产取证）', () => {
  it('agnes 503 queue_full 原文 → rate_limited（此前 15/17 全落 unknown）', () => {
    // 生产原文，未造样本：Agnes video create 503 + code/message 双字段
    expect(
      mapMessageToErrorCode(
        'Agnes video create 503: {"code":"video_queue_full","message":"video queue is full, please retry later (request id: 20261102174520474936102GP5DQImi)","data":null}',
      ),
    ).toBe('rate_limited')
  })

  it('无状态码的队列满文案 → rate_limited（两种分隔符都覆盖）', () => {
    expect(mapMessageToErrorCode('video queue is full, please retry later')).toBe('rate_limited')
    expect(mapMessageToErrorCode('video_queue_full')).toBe('rate_limited')
  })

  it('优先级保持：timeout + queue_full 混合文本仍归 upstream_timeout', () => {
    expect(mapMessageToErrorCode('timeout waiting, then video_queue_full')).toBe('upstream_timeout')
  })

  it('不误伤：无 queue_full 字面量的普通 503 保持 unknown', () => {
    expect(mapMessageToErrorCode('Agnes video create 503: internal error')).toBe('unknown')
  })
})

describe('isVideoQueueFullError（队列满延迟重提刀的形态判定，spec §3）', () => {
  it('生产原文 JSON 形态命中（未造样本）', () => {
    expect(
      isVideoQueueFullError(
        new Error(
          'Agnes video create 503: {"code":"video_queue_full","message":"video queue is full, please retry later (request id: 20261102174520474936102GP5DQImi)","data":null}',
        ),
      ),
    ).toBe(true)
  })

  it('裸文案与下划线形态命中', () => {
    expect(isVideoQueueFullError(new Error('video queue is full, please retry later'))).toBe(true)
    expect(isVideoQueueFullError(new Error('video_queue_full'))).toBe(true)
  })

  it('非 Error / 空串 / 普通错误不命中', () => {
    expect(isVideoQueueFullError(undefined)).toBe(false)
    expect(isVideoQueueFullError(new Error('Agnes video create 503: internal error'))).toBe(false)
    expect(isVideoQueueFullError('video queue is full')).toBe(true) // 字符串形态也支持
  })

  it('与 mapMessageToErrorCode 同源：命中谓词的文本归类 rate_limited（除 timeout 混合）', () => {
    const msg = 'Agnes video create 503: {"code":"video_queue_full"}'
    expect(isVideoQueueFullError(new Error(msg))).toBe(true)
    expect(mapMessageToErrorCode(msg)).toBe('rate_limited')
  })
})

// 2026-11-28 生产取证：会话 cmx05m9d2 的 23 张图全失败于参数类 400，
// 但 mapMessageToErrorCode 无 invalid_request 规则 ⇒ 全落 unknown，用户无有效文案。
describe('mapMessageToErrorCode · invalid_request（参数类 4xx，2026-11-28 生产取证）', () => {
  const N_MUST_BE_1 =
    'Image API 400: {"error":{"message":"n must be 1 (request id: 20261128084117814104848rqGYtTfA)","type":"invalid_request","param":"","code":"invalid_request"}}'

  it('n must be 1 生产原文 → invalid_input（此前落 unknown）', () => {
    expect(mapMessageToErrorCode(N_MUST_BE_1)).toBe('invalid_input')
  })

  it('裸 invalid_request 字面量 → invalid_input', () => {
    expect(mapMessageToErrorCode('Image API 400: {"code":"invalid_request","message":"bad param"}')).toBe(
      'invalid_input',
    )
  })

  it('不误伤：普通 400 / 其它错误仍保持 unknown', () => {
    expect(mapMessageToErrorCode('Image API 400: something else')).toBe('unknown')
    expect(mapMessageToErrorCode('Agnes video create 503: internal error')).toBe('unknown')
  })

  it('优先级保持：429/timeout/queue_full 混合参数串不被 invalid_input 抢走', () => {
    expect(mapMessageToErrorCode('429 rate limit, invalid_request')).toBe('rate_limited')
    expect(mapMessageToErrorCode('timeout then invalid_request')).toBe('upstream_timeout')
  })
})

describe('translateUpstreamFailure · invalid_request 文案', () => {
  it('n must be 1 生产原文 → 可理解中文文案（不再回落技术原文）', () => {
    const msg =
      'Image API 400: {"error":{"message":"n must be 1","type":"invalid_request","code":"invalid_request"}}'
    const copy = translateUpstreamFailure(msg)
    expect(copy).toBeDefined()
    expect(copy).toMatch(/参数|张数|模型/)
  })
})