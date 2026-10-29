import { describe, expect, it } from 'vitest'
import { turnStatusLine, resolveWaitingFromTimeline, failureReason } from '@/components/agent/turnStatusBar'
import { createTurnTimeline, applyTimelineEvent, type TimelinePart } from '@/components/agent/turnTimeline'

/** 从事件流构造 parts（复用模型层 reducer，避免手写 part 假数据漂移）。 */
function partsFrom(events: Parameters<typeof applyTimelineEvent>[1][]): TimelinePart[] {
  const tl = createTurnTimeline()
  for (const e of events) applyTimelineEvent(tl, e)
  return tl.parts
}

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

describe('resolveWaitingFromTimeline（根治规格 2026-10-28：waiting 单一真相 = 时间线）', () => {
  it('pending_confirm 的 proposal part ⇒ true（与对话流内联卡同源）', () => {
    const parts = partsFrom([
      { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', nodeId: 'n1' } },
    ])
    expect(resolveWaitingFromTimeline(parts)).toBe(true)
  })

  it('pending_answer 的 question part ⇒ true（ask_user 经时间线收敛）', () => {
    const parts = partsFrom([
      {
        type: 'ask_user',
        data: { callId: 'a1', questions: [{ id: 'q1', question: '选风格', options: [] }] },
      },
    ])
    expect(resolveWaitingFromTimeline(parts)).toBe(true)
  })

  it('resolved 后（proposal 翻 confirmed）⇒ false（状态行与对话流同步解除，不再双源抢跑）', () => {
    const tl = createTurnTimeline()
    applyTimelineEvent(tl, { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', nodeId: 'n1' } })
    expect(resolveWaitingFromTimeline(tl.parts)).toBe(true)
    applyTimelineEvent(tl, { type: 'waiting_user', data: { status: 'resolved', toolName: 'propose_generation' } })
    expect(resolveWaitingFromTimeline(tl.parts)).toBe(false)
  })

  it('空 / 无等待 parts（仅 tool/text/artifact）⇒ false（状态行不抢跑的判据）', () => {
    expect(resolveWaitingFromTimeline(undefined)).toBe(false)
    expect(resolveWaitingFromTimeline([])).toBe(false)
    const busy = partsFrom([
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'propose_generation', args: {} } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'propose_generation', result: {} } },
    ])
    // Q2 根因：tool_result 先于 waiting_user 到达时，旧双源判定会抢跑「等待」——
    // 时间线判定此刻 proposal part 尚未建立 ⇒ false，与对话流所见严格一致。
    expect(busy.some((p) => p.kind === 'tool')).toBe(true)
    expect(resolveWaitingFromTimeline(busy)).toBe(false)
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
