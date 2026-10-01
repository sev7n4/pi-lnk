import { afterEach, describe, expect, it, vi } from 'vitest'
import { submitAnswers, type AnswersPostInit } from './agentAnswers'

/**
 * 回归：生产 CVM 用明文 http://ip:port 访问，`crypto.randomUUID` 在非安全上下文
 * 不存在（undefined）。历史上 /answers 提交路径直接调它 → 同步抛 TypeError →
 * 被上层 catch 成「提交失败，请重试」，请求根本没发出（nginx 侧 0 条 /answers 记录）。
 * 本文件锁定：无 randomUUID 时提交照样成功，且 answerId 非空（幂等键不能为空）。
 */
function postOk() {
  const calls: { url: string; init: AnswersPostInit }[] = []
  const post = async (url: string, init: AnswersPostInit) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ code: 0, data: { ok: true, deduped: false } }) }
  }
  return { calls, post }
}

const base = { threadId: 'thread-1', sessionId: 'sess 1', callId: 'call-1', answers: { q1: ['a'] } }

describe('submitAnswers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('明文 HTTP（crypto.randomUUID 不可用）时仍能提交，answerId 非空', async () => {
    vi.stubGlobal('crypto', {}) // 非安全上下文：只有 crypto 壳子，没有 randomUUID
    const { calls, post } = postOk()
    const result = await submitAnswers(base, post)

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].init.body)
    expect(body.answerId).toBeTruthy()
    expect(body.callId).toBe('call-1')
    expect(body.answers).toEqual({ q1: ['a'] })
    expect(calls[0].url).toBe('/api/agent/sessions/sess%201/answers')
  })

  it('有 randomUUID 时同样走通（安全上下文不受影响）', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-fixed' })
    const { calls, post } = postOk()
    await submitAnswers(base, post)
    expect(JSON.parse(calls[0].init.body).answerId).toBe('uuid-fixed')
  })

  it('每次提交 answerId 不同（幂等键不复用）', async () => {
    vi.stubGlobal('crypto', {})
    const { calls, post } = postOk()
    await submitAnswers(base, post)
    await submitAnswers(base, post)
    const [a, b] = calls.map((c) => JSON.parse(c.init.body).answerId)
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
  })

  it('非 2xx 一律 throw（调用方靠 try/catch 恢复卡片）', async () => {
    vi.stubGlobal('crypto', {})
    await expect(
      submitAnswers(base, async () => ({ ok: false, json: async () => ({}) })),
    ).rejects.toThrow()
  })

  it('deduped 透传（迟到回答降级为普通消息的依据）', async () => {
    vi.stubGlobal('crypto', {})
    const result = await submitAnswers(base, async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { ok: true, deduped: true } }),
    }))
    expect(result).toEqual({ ok: true, deduped: true })
  })
})
