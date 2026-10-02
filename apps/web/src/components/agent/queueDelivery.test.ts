/**
 * `parseQueueDelivery` 单测（2026-10-02）
 *
 * 锁的是「用户的字绝不能静默蒸发」这一条。三类历史事故各对应一个用例：
 *   ① HTTP 200 但 `queued:false`（维护态）→ 必须判失败，否则消息蒸发；
 *   ② `code !== 0`（Nest 包层）→ 必须判失败；
 *   ③ `data` 缺失 → 按成功放行（保守，避免解析抖动判丢）。
 */
import { describe, expect, it } from 'vitest'
import { acceptedHint, parseQueueDelivery } from './queueDelivery'

describe('parseQueueDelivery（插话/尾随指令的入队判定）', () => {
  it('HTTP 200 + data.queued=true → 成功', () => {
    const r = parseQueueDelivery({
      ok: true,
      status: 200,
      body: { code: 0, message: 'ok', data: { queued: true } },
    })
    expect(r).toEqual({ delivered: true, reason: '' })
  })

  it('⚠️ HTTP 200 但 queued=false（pi-runtime 未接管的维护态）→ 判失败，绝不静默放行', () => {
    const r = parseQueueDelivery({ ok: true, status: 200, body: { code: 0, data: { queued: false } } })
    expect(r.delivered).toBe(false)
    expect(r.reason).toContain('未入队')
  })

  it('HTTP 4xx/5xx → 判失败，文案带状态码', () => {
    const r = parseQueueDelivery({ ok: false, status: 503, body: null })
    expect(r.delivered).toBe(false)
    expect(r.reason).toContain('503')
  })

  it('Nest 包层 code 非 0 → 判失败（HTTP 仍是 200）', () => {
    const r = parseQueueDelivery({ ok: true, status: 200, body: { code: 500, message: 'boom', data: null } })
    expect(r.delivered).toBe(false)
    expect(r.reason).toContain('code=500')
  })

  it('data 缺失 / body 为 null → 保守放行（宁可重试一条，也不要判丢用户的字）', () => {
    expect(parseQueueDelivery({ ok: true, status: 202, body: null }).delivered).toBe(true)
    expect(parseQueueDelivery({ ok: true, body: { code: 0 } }).delivered).toBe(true)
  })

  it('扁平结构（非 Nest 包层）的 queued=false 同样判失败', () => {
    expect(parseQueueDelivery({ ok: true, body: { queued: false } }).delivered).toBe(false)
  })
})

describe('acceptedHint（入队后的气泡文案，2026-10-02 组合漏洞）', () => {
  // 组合漏洞：agent 卡在 registry.waitForUser 里等答案时，prompting 恒为 true →
  // 端点一律 202 + queued:true，消息只能排在那份答案之后。此时文案若还写
  // 「已并入当前回答」就是假承诺（那一轮根本没在回答）。
  it('无未作答卡片：steer / followUp 各自保留原时序描述', () => {
    expect(acceptedHint('steer', false)).toContain('已并入当前回答')
    expect(acceptedHint('followup', false)).toContain('本轮收尾')
  })

  it('有未作答卡片：两条通道都改说「会排在你答完这张卡之后」', () => {
    for (const intent of ['steer', 'followup'] as const) {
      const hint = acceptedHint(intent, true)
      expect(hint).toContain('答完这张卡')
      expect(hint).not.toContain('已并入当前回答')
      expect(hint).not.toContain('本轮收尾')
    }
  })
})
