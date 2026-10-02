import { describe, expect, it } from 'vitest'
import { submitAnswers, type AnswersPostInit } from './agentAnswers'

/**
 * 回归：生产 CVM 用明文 http://ip:port 访问，`crypto.randomUUID` 在非安全上下文
 * 不存在（undefined）。历史上 /answers 提交路径直接调它 → 同步抛 TypeError →
 * 被上层 catch 成「提交失败，请重试」，请求根本没发出（nginx 侧 0 条 /answers 记录）。
 *
 * 2026-10-02 顺带删掉了 `answerId`（穿三层、零语义：registry.answer 从不读它，
 * 去重本来就靠 callId）——本文件同时锁定这条：**payload 不含 answerId**，
 * 免得它以「幂等键」之类的名义复活。
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
  it('明文 HTTP（crypto.randomUUID 不可用）时仍能提交', async () => {
    const { calls, post } = postOk()
    const result = await submitAnswers(base, post)

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].init.body)
    expect(body.threadId).toBe('thread-1')
    expect(body.callId).toBe('call-1')
    expect(body.answers).toEqual({ q1: ['a'] })
    expect(calls[0].url).toBe('/api/agent/sessions/sess%201/answers')
  })

  it('payload 不含 answerId（2026-10-02 删除，去重靠 callId，见 agentAnswers 注释）', async () => {
    const { calls, post } = postOk()
    await submitAnswers(base, post)
    const body = JSON.parse(calls[0].init.body)
    expect(body).not.toHaveProperty('answerId')
    expect(Object.keys(body).sort()).toEqual(['answers', 'callId', 'threadId'])
  })

  it('非 2xx 一律 throw（调用方靠 try/catch 恢复卡片）', async () => {
    await expect(
      submitAnswers(base, async () => ({ ok: false, json: async () => ({}) })),
    ).rejects.toThrow()
  })

  it('deduped 透传（迟到回答降级为普通消息的依据）', async () => {
    const result = await submitAnswers(base, async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { ok: true, deduped: true } }),
    }))
    expect(result).toEqual({ ok: true, deduped: true })
  })
})
