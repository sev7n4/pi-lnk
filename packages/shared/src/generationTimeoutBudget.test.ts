import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_VIDEO_REAP_MINUTES,
  MAX_VIDEO_POLL_DEADLINE_MS,
  SETTLE_TIMEOUT_FLOOR_MS,
  UPSTREAM_FETCH_TIMEOUT_MS,
  UPSTREAM_POLL_TIMEOUT_MS,
  VIDEO_CREATE_RETRY_ATTEMPTS,
  VIDEO_CREATE_RETRY_BASE_DELAY_MS,
  VIDEO_CREATE_RETRY_WORST_MS,
  VIDEO_POLL_DEADLINE_MS,
  VIDEO_SERVER_WORST_MS,
} from './generationTimeoutBudget'

/**
 * 跨层超时预算的**自洽性锁**。
 *
 * 本文件是三处消费方（web 墙钟 / agent 重试与轮询 / server reaper）的
 * 预算契约：任何常量改动必须过这组不等式，否则三层会静默失衡
 * （V6 之前 web 墙钟锁的是过时字面量、reaper 引用虚构常量，就是教训）。
 */
describe('generationTimeoutBudget（跨层超时预算单一来源）', () => {
  it('单次轮询超时必须小于单次请求超时（轮询周期不被单次卡死吃掉）', () => {
    expect(UPSTREAM_POLL_TIMEOUT_MS).toBeLessThan(UPSTREAM_FETCH_TIMEOUT_MS)
  })

  it('MAX_VIDEO_POLL_DEADLINE_MS 恒等于各 provider deadline 的最大值', () => {
    expect(MAX_VIDEO_POLL_DEADLINE_MS).toBe(Math.max(...Object.values(VIDEO_POLL_DEADLINE_MS)))
  })

  it('创建重试最坏耗时 = attempts × 单次超时 + 退避总和（base×(2^(n-1)-1)）', () => {
    const backoff = VIDEO_CREATE_RETRY_BASE_DELAY_MS * (2 ** (VIDEO_CREATE_RETRY_ATTEMPTS - 1) - 1)
    expect(VIDEO_CREATE_RETRY_WORST_MS).toBe(
      VIDEO_CREATE_RETRY_ATTEMPTS * UPSTREAM_FETCH_TIMEOUT_MS + backoff,
    )
  })

  it('服务端单笔视频最坏总耗时 = 最大轮询 deadline + 创建重试上界', () => {
    expect(VIDEO_SERVER_WORST_MS).toBe(MAX_VIDEO_POLL_DEADLINE_MS + VIDEO_CREATE_RETRY_WORST_MS)
  })

  it('web 墙钟下限 = 服务端最坏 + 60s，且实际墙钟 ≥ 下限', () => {
    expect(SETTLE_TIMEOUT_FLOOR_MS).toBe(VIDEO_SERVER_WORST_MS + 60_000)
    expect(DEFAULT_SETTLE_TIMEOUT_MS).toBeGreaterThanOrEqual(SETTLE_TIMEOUT_FLOOR_MS)
  })

  it('reaper video 默认阈值 ≥ 服务端最坏 + 5min 缓冲（不许把在生成的视频判成孤儿）', () => {
    expect(DEFAULT_VIDEO_REAP_MINUTES * 60_000).toBeGreaterThanOrEqual(
      VIDEO_SERVER_WORST_MS + 5 * 60_000,
    )
  })
})
