import { describe, expect, it } from 'vitest'
import { turnStatusLine, resolveWaiting, failureReason } from '@/components/agent/turnStatusBar'

describe('turnStatusLine（P1 状态行）', () => {
  const t0 = 1_000_000
  it('running：秒数随 now 跳动', () => {
    expect(turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 3400, waiting: false }))
      .toEqual({ text: '生成回复中 · 3s', mode: 'running' })
  })
  it('waiting：文案切换且秒数冻结', () => {
    expect(turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 9000, waiting: true }))
      .toEqual({ text: '等待你确认', mode: 'waiting' })
  })
  it('failed：带原因摘要，isStreaming 可已为 false', () => {
    expect(turnStatusLine({ isStreaming: false, turnStartedAt: t0, now: t0 + 2000, waiting: false, lastFailed: '渠道密钥无效' }))
      .toEqual({ text: '生成失败 · 渠道密钥无效', mode: 'failed' })
  })
  it('非流式无失败 → null（不渲染状态行）', () => {
    expect(turnStatusLine({ isStreaming: false, turnStartedAt: t0, now: t0, waiting: false })).toBeNull()
  })
})

describe('resolveWaiting（P1 waiting 收紧）', () => {
  it('propose pending_confirm 一票通过（即使文本仍在静默前）', () => {
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: true, chipSet: null, textIdleMs: 0 })).toBe(true)
  })
  it('纯文本片段 chip 需文本静默 ≥2s（防流式途中假阳性）', () => {
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: false, chipSet: 'copy', textIdleMs: 300 })).toBe(false)
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: false, chipSet: 'copy', textIdleMs: 2500 })).toBe(true)
  })
  it('非流式恒 false；无 chip 且无 propose 恒 false', () => {
    expect(resolveWaiting({ isStreaming: false, proposePendingConfirm: true, chipSet: 'plan', textIdleMs: 9999 })).toBe(false)
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: false, chipSet: null, textIdleMs: 9999 })).toBe(false)
  })
})

describe('failureReason（P1 失败人话）', () => {
  it('状态码与超时映射；未知兜底', () => {
    expect(failureReason({ status: 401 })).toBe('渠道密钥无效')
    expect(failureReason({ status: 429 })).toBe('额度或频率受限')
    expect(failureReason(new Error('request timeout'))).toBe('上游响应超时')
    expect(failureReason('boom')).toBe('生成失败，请重试')
  })
})
