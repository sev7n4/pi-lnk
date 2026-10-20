import { describe, expect, it } from 'vitest'
import { isNetworkError, classifyRequestError, businessHuman } from '@/components/agent/networkFault'

describe('isNetworkError', () => {
  it('识别浏览器 fetch 网络失败（无 HTTP 状态）', () => {
    expect(isNetworkError(new TypeError('NetworkError'))).toBe(true)
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new Error('network error'))).toBe(true)
    expect(isNetworkError(new Error('Load failed'))).toBe(true)
  })
  it('带 HTTP 状态码的错误不算连接级（哪怕 5xx）', () => {
    expect(isNetworkError({ status: 502, message: 'Bad Gateway' })).toBe(false)
    expect(isNetworkError({ response: { status: 500 } })).toBe(false)
  })
  it('非网络无状态错误不算', () => {
    expect(isNetworkError(new Error('boom'))).toBe(false)
    expect(isNetworkError(null)).toBe(false)
  })
})

describe('businessHuman（与 failureReason 映射一致）', () => {
  it('已知状态码', () => {
    expect(businessHuman(402)).toBe('渠道余额不足')
    expect(businessHuman(401)).toBe('渠道密钥无效')
    expect(businessHuman(403)).toBe('渠道无权限')
    expect(businessHuman(429)).toBe('额度或频率受限')
  })
  it('未知状态码兜底带数字', () => {
    expect(businessHuman(500)).toBe('服务异常（500）')
  })
})

describe('classifyRequestError', () => {
  it('业务级优先于连接级/未知', () => {
    expect(classifyRequestError({ status: 429 })).toEqual({
      kind: 'business',
      status: 429,
      human: '额度或频率受限',
    })
    expect(classifyRequestError({ response: { status: 401 } })).toEqual({
      kind: 'business',
      status: 401,
      human: '渠道密钥无效',
    })
  })
  it('连接级 → network + 人话', () => {
    expect(classifyRequestError(new TypeError('network error'))).toEqual({
      kind: 'network',
      human: '网络连接不稳定，请检查网络后重试',
    })
  })
  it('超时 → unknown + 上游响应超时', () => {
    expect(classifyRequestError(new Error('request timeout'))).toEqual({
      kind: 'unknown',
      human: '上游响应超时',
    })
  })
  it('兜底 → unknown + 请重试', () => {
    expect(classifyRequestError('boom')).toEqual({
      kind: 'unknown',
      human: '生成失败，请重试',
    })
  })
})
