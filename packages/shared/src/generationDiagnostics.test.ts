import { describe, expect, it } from 'vitest'
import {
  formatDiagnosticCopy,
  redactProviderSnippet,
  mapMessageToErrorCode,
  translateUpstreamFailure,
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
