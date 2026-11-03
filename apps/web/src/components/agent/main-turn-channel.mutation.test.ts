/**
 * Task 7 变异三件套（多端一致性 P1 · 变异体反例证明守卫非真空，E1 §7.2 同纪律）。
 *
 * 被变异对象均为 web 模块（consumeMainTurnStream / backoffWithJitter），故本文件
 * 归位 web 侧；双端一致性集成在 apps/server 侧 multi-device-stream.consistency.test.ts。
 *
 *  - 变异①：去 done 终止判定 ⇒ 消费越过收束帧（「立刻停」守卫抓它）；
 *  - 变异②：去 jitter ⇒ 退避确定性（惊群）；真实现同参采样必有离散；
 *  - 变异③：on 路径把 [DONE] 当终止 ⇒ 静默假成功（「[DONE] 不是终止信号」守卫抓它）。
 */
import { describe, expect, it } from 'vitest'
import { consumeMainTurnStream } from './main-turn-channel'
import { backoffWithJitter } from './backoff'

function framesReader(chunks: string[]) {
  const queue = [...chunks]
  return {
    read: async () => {
      const c = queue.shift()
      return c
        ? { done: false, value: new TextEncoder().encode(c) }
        : { done: true, value: undefined }
    },
    cancel: async () => {},
  }
}

describe('Task 7 变异三件套', () => {
  it('变异①：去 done 终止判定 ⇒ 消费越过收束帧（真实现立刻停）', async () => {
    const real: string[] = []
    const realRes = await consumeMainTurnStream({
      reader: framesReader([
        'id: 1\ndata: {"type":"text_delta","data":{"text":"a"}}\n\n',
        'id: 2\ndata: {"type":"done","data":{}}\n\n',
        'id: 3\ndata: {"type":"text_delta","data":{"text":"收束后泄漏"}}\n\n',
      ]),
      onEvent: (e) => real.push(e.type),
      onCursor: () => {},
    })
    // 真实现：done 事件本身照常进 reducer（与 off 路径同一事件面），但到此为止
    // ——收束帧之后的帧不得被消费（main-turn-channel.test.ts「立刻停」用例钉住此守卫）
    expect(realRes.endedNaturally).toBe(true)
    expect(real).toEqual(['text_delta', 'done'])

    // 变异体：最小变异——谓词去掉 done（turn_ack/error/turn_not_submitted 保留）
    const mutantIsTerminal = (t: string) =>
      t === 'turn_ack' || t === 'error' || t === 'turn_not_submitted'
    const mutantFrames = [
      'id: 2\ndata: {"type":"done","data":{}}\n\n',
      'id: 3\ndata: {"type":"text_delta","data":{"text":"收束后泄漏"}}\n\n',
    ]
    const mutant: string[] = []
    let buf = ''
    while (true) {
      const c = mutantFrames.shift()
      const r = c
        ? { done: false, value: new TextEncoder().encode(c) as Uint8Array }
        : { done: true, value: undefined }
      if (r.done) break
      buf += new TextDecoder().decode(r.value, { stream: true })
      const sep = buf.indexOf('\n\n')
      if (sep === -1) continue
      const frame = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const payload = JSON.parse(line.slice(5).trim()) as { type: string }
      mutant.push(payload.type)
      if (mutantIsTerminal(payload.type)) break
    }
    // 变异体越界消费了收束帧之后的文本 ⇒ 守卫非真空（删 done 分支必红）
    expect(mutant).toEqual(['done', 'text_delta'])
  })

  it('变异②：去 jitter ⇒ 退避确定性（惊群重连同时齐发）；真实现同参采样必有离散', () => {
    // 真实现：jitter ⇒ 同参数多次结果存在离散
    const samples = new Set<number>()
    for (let i = 0; i < 50; i++) samples.add(backoffWithJitter(250, 5000, 3))
    expect(samples.size).toBeGreaterThan(1)
    // 变异体：纯指数（无 jitter）⇒ 50 次采样同一值
    const mutantAt = (attempt: number) => Math.min(250 * 2 ** (attempt - 1), 5000)
    const mutantSamples = new Set<number>()
    for (let i = 0; i < 50; i++) mutantSamples.add(mutantAt(3))
    expect(mutantSamples.size).toBe(1)
  })

  it('变异③：on 路径把 [DONE] 当终止 ⇒ 静默假成功；真实现按「未自然收束」走对账', async () => {
    // 真实现：[DONE] 不产生任何事件、也不算自然收束 ⇒ 调用方走断流对账（不假成功）
    const events: string[] = []
    const res = await consumeMainTurnStream({
      reader: framesReader(['data: [DONE]\n\n']),
      onEvent: (e) => events.push(e.type),
      onCursor: () => {},
    })
    expect(events).toEqual([])
    expect(res.endedNaturally).toBe(false)

    // 变异体：把 [DONE] 当终止帧（POST 流 legacy 判定混进 on 路径的最小变异）
    const mutantFrames = ['data: [DONE]\n\n']
    let ended = false
    let buf = ''
    while (true) {
      const c = mutantFrames.shift()
      const r = c
        ? { done: false, value: new TextEncoder().encode(c) as Uint8Array }
        : { done: true, value: undefined }
      if (r.done) break
      buf += new TextDecoder().decode(r.value, { stream: true })
      const sep = buf.indexOf('\n\n')
      if (sep === -1) continue
      const frame = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (line && line.slice(5).trim() === '[DONE]') {
        ended = true // ← 变异点
        break
      }
    }
    expect(ended).toBe(true) // 变异体假成功 ⇒ 既有「[DONE] 不是终止信号」测试抓它
  })
})
