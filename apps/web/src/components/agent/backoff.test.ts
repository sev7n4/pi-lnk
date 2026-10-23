/**
 * 退避重连的抖动算法（multi-device Task 5 · Review Focus #1 的基础设施）。
 *
 * 为什么旁听流重连必须带抖动：两端（PC/手机）同会话断网时，若退避无抖动，
 * 重连请求会打在同一时刻（thundering herd），把 Nest/pi-runtime 又压一次。
 * 抖动区间刻意取 [0.5, 1.5)×exp 而非 [0, exp)——后者会把请求摊到「最早可能时刻」
 * 太远，用户回来看见的是空白而不是续传。
 *
 * 判据钉在**行为**上（取值区间 + 抖动确实存在 + 封顶），不是实现细节。
 */
import { describe, expect, it, vi } from 'vitest'
import { backoffWithJitter } from './backoff'

describe('backoffWithJitter（multi-device Task 5）', () => {
  it('必须带抖动：20 次取样应有多值（无抖动会全是同一个数）', () => {
    const samples = Array.from({ length: 20 }, () => backoffWithJitter(250, 5000, 3))
    expect(new Set(samples).size, '无抖动的退避会让并发重连打在同一时刻').toBeGreaterThan(1)
  })

  it('取值区间：下限 = exp×0.5，上限 = exp×1.5（含抖动）', () => {
    for (const attempt of [0, 1, 2, 3]) {
      for (let i = 0; i < 50; i += 1) {
        const d = backoffWithJitter(250, 5000, attempt)
        const exp = Math.min(250 * 2 ** attempt, 5000)
        expect(d, `attempt=${attempt} 低于下限 ${exp / 2}`).toBeGreaterThanOrEqual(exp / 2)
        expect(d, `attempt=${attempt} 高于上限 ${exp * 1.5}`).toBeLessThanOrEqual(exp * 1.5)
      }
    }
  })

  it('指数增长：相邻 attempt 的期望随次数上升', () => {
    // 用大量取样比均值，避免单次抖动噪声误判
    const mean = (attempt: number) => {
      let s = 0
      for (let i = 0; i < 500; i += 1) s += backoffWithJitter(250, 5000, attempt)
      return s / 500
    }
    expect(mean(2)).toBeGreaterThan(mean(0))
    expect(mean(3)).toBeGreaterThan(mean(1))
  })

  it('封顶：attempt 很大时不得超过 cap×1.5', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(backoffWithJitter(250, 5000, 20)).toBeLessThanOrEqual(5000 * 1.5)
    }
  })

  it('random 打桩时可复现（证明返回值真的由 exp×随机项决定）', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      // 0.5 + 0.5 = 1.0 ⇒ 恰为 exp
      expect(backoffWithJitter(250, 5000, 1)).toBe(500)
      // 0.5 + 0 = 0.5 ⇒ exp×0.5
      spy.mockReturnValue(0)
      expect(backoffWithJitter(250, 5000, 1)).toBe(250)
    } finally {
      spy.mockRestore()
    }
  })

  it('返回整数毫秒（setTimeout 语义）', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(Number.isInteger(backoffWithJitter(250, 5000, 2))).toBe(true)
    }
  })
})
