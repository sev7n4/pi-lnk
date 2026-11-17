/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { friendlyAssistantError } from './apiError'

describe('friendlyAssistantError（U-3 上游限频错误友好化，2026-11-17 E2E）', () => {
  it('agnes 429 原始 JSON dump → rate_limit 人话文案', () => {
    const raw =
      '{"code":"assistant_error","message":"rate limit for free users, current: 3, limit: 3, please retry after 2026-11-17 18:12:30 UTC+8","request_id":"req-abc-123"}'
    const out = friendlyAssistantError(raw)
    expect(out.kind).toBe('rate_limit')
    expect(out.text).toContain('限频')
    expect(out.text).not.toContain('request_id')
    expect(out.text).not.toContain('{')
  })

  it('裸 HTTP 429 文本同样命中 rate_limit', () => {
    const out = friendlyAssistantError('HTTP 429 Too Many Requests')
    expect(out.kind).toBe('rate_limit')
  })

  it('model_not_found → 切换模型引导', () => {
    const out = friendlyAssistantError(
      '{"error":{"code":"model_not_found","message":"model deepseek-v4-flash not found for channel byok-e82c5cf560d4"}}',
    )
    expect(out.kind).toBe('model_not_found')
    expect(out.text).toContain('切换模型')
  })

  it('未知错误 generic 透传（不破坏现有未见过的错误呈现）', () => {
    const raw = '内部错误：数据库连接失败'
    const out = friendlyAssistantError(raw)
    expect(out.kind).toBe('generic')
    expect(out.text).toBe(raw)
  })

  it('空/非法输入安全回落 generic', () => {
    expect(friendlyAssistantError('').kind).toBe('generic')
    expect(friendlyAssistantError(undefined as unknown as string).kind).toBe('generic')
  })
})
