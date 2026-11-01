import { describe, expect, it } from 'vitest'
import { SETTLE_TIMEOUT_FLOOR_MS } from '@lnkpi/shared'
import {
  settleDeadlineExceeded,
  DEFAULT_SETTLE_TIMEOUT_MS,
} from './generationPollGate'

// U6 回归锁。审计 §2.6 记的是「三处 while(true) 轮询无墙钟上限」，
// 实测只有 1 处 `for (;;)`（useNodeGeneration.ts:745waitForRunGroupMemberSettled）
// + 1 处独立轮询模块（useGenerationPolling.ts）—— **审计的函数名/形态记错了**，
// 但「无墙钟上限」这个结论成立。
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.6

describe('settleDeadlineExceeded', () => {
  it('returns false before the deadline', () => {
    // ⚠️ 必须显式传 now：startedAt:0 是 1970 年，配Date.now() 必然已超时
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: 1000, now: 999 })).toBe(false)
  })

  it('returns true after the deadline', () => {
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: 1000, now: 1001 })).toBe(true)
  })

  it('treats exactly-at-deadline as exceeded (>=, not >)', () => {
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: 1000, now: 1000 })).toBe(true)
  })

  it('is false when no timeout is configured (opt-out)', () => {
    // 必须允许「显式不设上限」—— 否则测试与某些长任务会被误杀
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: undefined, now: 9_999_999 })).toBe(
      false,
    )
    expect(settleDeadlineExceeded({ startedAt: 0, now: 9_999_999 })).toBe(false)
  })

  it('handles a 0 or negative timeout as immediately exceeded', () => {
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: 0, now: 0 })).toBe(true)
    expect(settleDeadlineExceeded({ startedAt: 0, timeoutMs: -1, now: 0 })).toBe(true)
  })
  it('uses Date.now() when now is not supplied', () => {
    expect(settleDeadlineExceeded({ startedAt: Date.now(), timeoutMs: 60_000 })).toBe(false)
  })
})

describe('DEFAULT_SETTLE_TIMEOUT_MS', () => {
  it('covers the worst-case server generation time + V6 create-retry upper bound + buffer', () => {
    // 前端墙钟必须 ≥ 服务端真实最坏生成耗时 + 缓冲，否则服务端还在跑、
    // 客户端已先放弃 ⇒ 用户看到假失败（钱已扣、历史里却是成功）。
    //
    // 2026-10-09 起服务端最坏耗时由 @lnkpi/shared/generationTimeoutBudget
    // 单一来源派生（MiniMax H3 deadline + V6 创建重试上界），本测试直接
    // 引用 SETTLE_TIMEOUT_FLOOR_MS——三层任一常量变动都会即时反映到这里，
    // 不再有「本地字面量过期仍全绿」的假绿温床。
    expect(DEFAULT_SETTLE_TIMEOUT_MS).toBeGreaterThanOrEqual(SETTLE_TIMEOUT_FLOOR_MS)
  })
})

