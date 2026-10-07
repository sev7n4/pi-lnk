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
  it('waiting + propose_generation → 文案点明去画布确认（2026-10-01 卡死修复）', () => {
    expect(
      turnStatusLine({
        isStreaming: true,
        turnStartedAt: t0,
        now: t0 + 931_000,
        waiting: true,
        waitingTool: 'propose_generation',
      }),
    ).toEqual({ text: '等待你在画布上确认生成', mode: 'waiting' })
  })
  it('waiting + ask_user → 通用「等待你确认」（选项卡已在聊天内）', () => {
    expect(
      turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 5000, waiting: true, waitingTool: 'ask_user' }),
    ).toEqual({ text: '等待你确认', mode: 'waiting' })
  })
})

describe('resolveWaiting（P1 waiting 收紧）', () => {
  it('propose pending_confirm 一票通过', () => {
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: true })).toBe(true)
  })
  it('非流式恒 false；两个信号都缺席恒 false', () => {
    expect(resolveWaiting({ isStreaming: false, proposePendingConfirm: true })).toBe(false)
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: false })).toBe(false)
  })
  it('阻塞等待一票通过：等待开始即收口，不等 tool_result（2026-10-01）', () => {
    expect(
      resolveWaiting({
        isStreaming: true,
        proposePendingConfirm: false, // 阻塞模式下等待期恒 false —— 正是旧判据失效的场景
        blockingWait: { toolName: 'propose_generation' },
      }),
    ).toBe(true)
    expect(
      resolveWaiting({
        isStreaming: true,
        proposePendingConfirm: false,
        blockingWait: { toolName: 'ask_user' },
      }),
    ).toBe(true)
  })
  it('blockingWait 为空 / 非流式 → 不误判（回归旧语义）', () => {
    expect(
      resolveWaiting({
        isStreaming: true,
        proposePendingConfirm: false,
        blockingWait: null,
      }),
    ).toBe(false)
    expect(
      resolveWaiting({
        isStreaming: false,
        proposePendingConfirm: false,
        blockingWait: { toolName: 'propose_generation' },
      }),
    ).toBe(false)
  })
})

describe('turnStatusLine（P0 两行状态行）', () => {
  const t0 = 2_000_000
  it('running：有 activity 时替换「生成回复中」为主语', () => {
    expect(turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 3400, waiting: false, activity: '创建节点' }))
      .toEqual({ text: '创建节点 · 3s', mode: 'running' })
  })
  it('running：无 activity → 保持原「生成回复中」文案（回归防线）', () => {
    expect(turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 3400, waiting: false }))
      .toEqual({ text: '生成回复中 · 3s', mode: 'running' })
  })
  it('waiting：带截止时刻 → hint 倒计时；无截止 → 无 hint', () => {
    expect(turnStatusLine({
      isStreaming: true, turnStartedAt: t0, now: t0 + 5000, waiting: true,
      waitingTool: 'propose_generation', waitingDeadline: t0 + 305_000,
    })).toEqual({ text: '等待你在画布上确认生成', hint: '还剩 5 分钟自动取消', mode: 'waiting' })
    expect(turnStatusLine({
      isStreaming: true, turnStartedAt: t0, now: t0 + 5000, waiting: true,
    })).toEqual({ text: '等待你确认', mode: 'waiting' })
  })
})

describe('failureReason（P1 失败人话）', () => {
  it('状态码与超时映射；未知兜底', () => {
    expect(failureReason({ status: 402 })).toBe('渠道余额不足')
    expect(failureReason({ status: 401 })).toBe('渠道密钥无效')
    expect(failureReason({ status: 429 })).toBe('额度或频率受限')
    expect(failureReason(new Error('request timeout'))).toBe('上游响应超时')
    expect(failureReason('boom')).toBe('生成失败，请重试')
  })
})
