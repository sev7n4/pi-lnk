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
  it('Q2：running 带预估积分 → 拼「· 预估 -N积分」；null/0 → 缺省不拼（杜绝 0 积分假象）', () => {
    expect(turnStatusLine({
      isStreaming: true, turnStartedAt: t0, now: t0 + 3000, waiting: false, estimatedCredits: 8,
    })).toEqual({ text: '生成回复中 · 3s · 预估 -8积分', mode: 'running' })
    expect(turnStatusLine({
      isStreaming: true, turnStartedAt: t0, now: t0 + 3000, waiting: false, estimatedCredits: null,
    })).toEqual({ text: '生成回复中 · 3s', mode: 'running' })
    expect(turnStatusLine({
      isStreaming: true, turnStartedAt: t0, now: t0 + 3000, waiting: false, estimatedCredits: 0,
    })).toEqual({ text: '生成回复中 · 3s', mode: 'running' })
  })
})

describe('turnStatusLine（P2 T7 settled 收口态）', () => {
  const t0 = 4_000_000
  const settledText = '已结算 -8 积分（输入 3.0k · 缓存 0 · 输出 400）'
  it('非流式 + settledText → mode settled，文案单源透传', () => {
    expect(
      turnStatusLine({ isStreaming: false, turnStartedAt: t0, now: t0, waiting: false, settledText }),
    ).toEqual({ text: settledText, mode: 'settled' })
  })
  it('failed 优先于 settled（error 路径 released 不覆盖失败原因）', () => {
    expect(
      turnStatusLine({
        isStreaming: false, turnStartedAt: t0, now: t0, waiting: false,
        lastFailed: '上游响应超时', settledText: '预扣已退回',
      }),
    ).toEqual({ text: '生成失败 · 上游响应超时', mode: 'failed' })
  })
  it('非流式无失败无 settledText → null（回归不变）', () => {
    expect(turnStatusLine({ isStreaming: false, turnStartedAt: t0, now: t0, waiting: false, settledText: null })).toBeNull()
  })
  it('streaming 中无视 settledText（running 语义不变）', () => {
    expect(
      turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 3000, waiting: false, settledText }),
    ).toEqual({ text: '生成回复中 · 3s', mode: 'running' })
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
  it('连接级 fetch 失败 → 人话而非原始技术文案（2026-10-21 复盘）', () => {
    expect(failureReason(new TypeError('NetworkError'))).toBe('网络连接不稳定，请检查网络后重试')
    // 截图原始文案：TypeError: network error
    expect(failureReason(new Error('network error'))).toBe('网络连接不稳定，请检查网络后重试')
  })
})

describe('turnStatusLine（P2 恢复态：会话恢复中 vs 真上游超时）', () => {
  const t0 = 3_000_000
  it('recovering：显示「会话恢复中」而非常规文案', () => {
    expect(turnStatusLine({
      isStreaming: true, turnStartedAt: t0, now: t0 + 4200, waiting: false, recovering: true,
    })).toEqual({ text: '会话恢复中 · 4s', mode: 'running' })
  })
  it('recovering：有 activity 也让位恢复文案（恢复是更准确的信号）', () => {
    expect(turnStatusLine({
      isStreaming: true, turnStartedAt: t0, now: t0 + 4200, waiting: false,
      recovering: true, activity: '创建节点',
    })).toEqual({ text: '会话恢复中 · 4s', mode: 'running' })
  })
  it('waiting 优先于 recovering（用户须操作 > 恢复中）', () => {
    expect(turnStatusLine({
      isStreaming: true, turnStartedAt: t0, now: t0 + 4200, waiting: true, recovering: true,
    })).toEqual({ text: '等待你确认', mode: 'waiting' })
  })
  it('真实进度清位后回常规文案（回归防线）', () => {
    expect(turnStatusLine({
      isStreaming: true, turnStartedAt: t0, now: t0 + 4200, waiting: false, recovering: false,
    })).toEqual({ text: '生成回复中 · 4s', mode: 'running' })
  })
  it('非流式不进恢复态（failed 语义不变，仍显示上游超时）', () => {
    expect(turnStatusLine({
      isStreaming: false, turnStartedAt: t0, now: t0 + 4200, waiting: false, recovering: true,
      lastFailed: '上游响应超时',
    })).toEqual({ text: '生成失败 · 上游响应超时', mode: 'failed' })
  })
})
