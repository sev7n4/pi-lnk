/**
 * 多端一致性 P1（计划 2026-11-04 Task 5）：ack 分派与解析纯函数。
 * 契约详见 main-turn-ack.ts 头注释（Content-Type 分派 / 形状非法 ⇒ null）。
 */
import { describe, expect, it } from 'vitest'
import { isConversationAckResponse, parseConversationAck } from './main-turn-ack'

const resWith = (ct: string | null) => ({ headers: { get: () => ct } })

describe('isConversationAckResponse（Content-Type 分派，唯一判据）', () => {
  it('application/json ⇒ ack；text/event-stream ⇒ POST 体流', () => {
    expect(isConversationAckResponse(resWith('application/json'))).toBe(true)
    expect(isConversationAckResponse(resWith('application/json; charset=utf-8'))).toBe(true)
    expect(isConversationAckResponse(resWith('text/event-stream'))).toBe(false)
    expect(isConversationAckResponse(resWith(null))).toBe(false)
  })
})

describe('parseConversationAck（包络解包 + 形状校验）', () => {
  it('标准包络 {code,data} ⇒ 解出 accepted/threadId/sinceSeq', () => {
    const ack = parseConversationAck({
      code: 0,
      message: 'ok',
      data: { accepted: true, threadId: 'T2', sinceSeq: 7 },
    })
    expect(ack).toEqual({ accepted: true, threadId: 'T2', sinceSeq: 7 })
  })

  it('accepted=false + errorMessage（fork 失败）⇒ 原样透传', () => {
    const ack = parseConversationAck({
      code: 0,
      data: { accepted: false, errorMessage: '重跑失败：目标消息已不存在' },
    })
    expect(ack).toEqual({ accepted: false, errorMessage: '重跑失败：目标消息已不存在' })
  })

  it('sinceSeq 非法（负数/小数/字符串）⇒ 省略（前端 from=now 语义）', () => {
    for (const bad of [-1, 3.5, '7', null]) {
      const ack = parseConversationAck({ data: { accepted: true, sinceSeq: bad } })
      expect(ack?.sinceSeq).toBeUndefined()
    }
  })

  it('形状非法（null/非对象/data 缺失/accepted 非布尔）⇒ null（调用方按发起失败终态处理）', () => {
    expect(parseConversationAck(null)).toBeNull()
    expect(parseConversationAck('x')).toBeNull()
    expect(parseConversationAck({ code: 0 })).toBeNull()
    expect(parseConversationAck({ data: { accepted: 'yes' } })).toBeNull()
  })
})
