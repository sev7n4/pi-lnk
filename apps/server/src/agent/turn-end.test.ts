import { describe, expect, it } from 'vitest'
import {
  classifyTurnEnd, deriveSignalsFromRecord, deriveSignalsFromStream,
  outstandingToolCallIds, shouldEmitInterrupted, shouldReleaseHold,
  type TraceEventLike, type TurnEndSignals,
} from './turn-end'

/**
 * 生产只读快照夹具（2026-11-11，lnkpi-api SQLite AgentMessage.metadata）。
 * A = cmwbvfp4p000qrk01pch77w13（故障会话，pod 在 tool_call 后 0.4s 被替换）
 * B = …42ap2hej（同工具正常返回，78.9s 后有完整 tool_result）
 * 已脱敏：仅保留 type/seq/gSeq 与判定所需字段。
 */
const A_EVENTS: TraceEventLike[] = [
  { type: 'thinking', seq: 1, gSeq: 5 },
  { type: 'text', seq: 2, gSeq: 147 },
  { type: 'thinking', seq: 3, gSeq: 147 },
  { type: 'tool_call', seq: 4, gSeq: 152,
    data: { toolCallId: 'call_334ae8e2832146608be265e9', name: 'spawn_subagent' } },
  { type: 'turn_settled', seq: 5, gSeq: 152,
    data: { credits: 1, tokens: { in: 0, cache: 0, out: 0 } } },
]
const A_META = { truncated: true }

const B_EVENTS: TraceEventLike[] = [
  { type: 'thinking', seq: 1, gSeq: 4665 },
  { type: 'text', seq: 2, gSeq: 4778 },
  { type: 'tool_call', seq: 4, gSeq: 4783,
    data: { toolCallId: 'call_b55c3b4616434aada4967bf4', name: 'spawn_subagent' } },
  { type: 'tool_result', seq: 5, gSeq: 4784,
    data: { toolCallId: 'call_b55c3b4616434aada4967bf4', name: 'spawn_subagent' } },
  { type: 'turn_usage', seq: 9, gSeq: 6870,
    data: { inputTokens: 9459, outputTokens: 2820 } },
  { type: 'turn_settled', seq: 10, gSeq: 6870, data: { credits: 12 } },
]
const B_META = {}   // 键不出现纪律：完整回合不写 truncated

const signals = (over: Partial<TurnEndSignals> = {}): TurnEndSignals => ({
  sawTerminalEvent: false, runFailed: false, sawWaitingUser: false,
  loopCompletedNaturally: true, isOwner: true, promptAccepted: true,
  hasTurnUsage: false, hasOutstandingToolCall: true,
  ...over,
})

describe('turn-end：贴真实生产记录求值', () => {
  it('A（阳性）：零 usage + 未配对 spawn ⇒ interrupted / 发事件 / 释放 hold', () => {
    const s = deriveSignalsFromRecord(A_EVENTS, A_META)
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldEmitInterrupted(k)).toBe(true)
    expect(shouldReleaseHold(s, k)).toBe(true)
    expect(outstandingToolCallIds(A_EVENTS)).toEqual(['call_334ae8e2832146608be265e9'])
  })

  it('B（阴性）：配对结果 + turn_usage ⇒ completed / 两动作均 false', () => {
    const s = deriveSignalsFromRecord(B_EVENTS, B_META)
    const k = classifyTurnEnd(s)
    expect(k).toBe('completed')
    expect(shouldEmitInterrupted(k)).toBe(false)
    expect(shouldReleaseHold(s, k)).toBe(false)
    expect(outstandingToolCallIds(B_EVENTS)).toEqual([])
  })
})

describe('turn-end：变异自检（每项必须能 RED）', () => {
  it('M1 A 的 truncated 改 false ⇒ completed，两动作 false', () => {
    const s = deriveSignalsFromRecord(A_EVENTS, {})
    expect(classifyTurnEnd(s)).toBe('completed')
    expect(shouldReleaseHold(s, classifyTurnEnd(s))).toBe(false)
  })

  it('M2 A 补配对 tool_result ⇒ 不释放（证明窄判据非自匹配恒绿）', () => {
    const s = deriveSignalsFromRecord(
      [...A_EVENTS, { type: 'tool_result', data: { toolCallId: 'call_334ae8e2832146608be265e9' } }],
      A_META,
    )
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('M3 A 补 turn_usage ⇒ 不释放（零 usage 条件生效）', () => {
    const s = deriveSignalsFromRecord(
      [...A_EVENTS, { type: 'turn_usage', data: { inputTokens: 10 } }], A_META,
    )
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('M4 B 删 turn_usage + 删 tool_result + truncated=true ⇒ 转 interrupted 且释放（证明非恒假）', () => {
    const evs = B_EVENTS.filter((e) => e.type !== 'turn_usage' && e.type !== 'tool_result')
    const s = deriveSignalsFromRecord(evs, { truncated: true })
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldReleaseHold(s, k)).toBe(true)
  })

  it('M5 独立挂起样本 C：truncated=true + waiting_user{waiting} ⇒ suspended，两动作 false', () => {
    const s = deriveSignalsFromRecord(
      [...A_EVENTS, { type: 'waiting_user', data: { status: 'waiting' } }], A_META,
    )
    const k = classifyTurnEnd(s)
    expect(k).toBe('suspended')
    expect(shouldEmitInterrupted(k)).toBe(false)
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('M6 判定顺序：agent_end 之后断连 ⇒ detached（不是 completed）', () => {
    const s = signals({ sawTerminalEvent: true, loopCompletedNaturally: false })
    expect(classifyTurnEnd(s)).toBe('detached')
  })

  it('shadow 流 ⇒ shadow，两动作 false', () => {
    const s = signals({ isOwner: false })
    const k = classifyTurnEnd(s)
    expect(k).toBe('shadow')
    expect(shouldEmitInterrupted(k)).toBe(false)
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('waiting resolved 后不残留挂起态', () => {
    const s = deriveSignalsFromRecord(
      [
        ...A_EVENTS,
        { type: 'waiting_user', data: { status: 'waiting' } },
        { type: 'waiting_user', data: { status: 'resolved' } },
      ],
      A_META,
    )
    expect(classifyTurnEnd(s)).toBe('interrupted')
  })
})

describe('turn-end：静态守卫与范围边界', () => {
  it('零 usage 不得 settle credits>0：A 的 settled 带 credits 时判据仍要求释放', () => {
    const s = deriveSignalsFromRecord(A_EVENTS, A_META)
    expect(s.hasTurnUsage).toBe(false)
    expect(shouldReleaseHold(s, classifyTurnEnd(s))).toBe(true)
  })

  it('纯文本断流（无 tool_call）：不释放 hold（范围边界，不是 bug）', () => {
    const s = deriveSignalsFromRecord(
      [{ type: 'text' }, { type: 'turn_settled', data: { credits: 1 } }],
      { truncated: true },
    )
    const k = classifyTurnEnd(s)
    expect(k).toBe('interrupted')
    expect(shouldEmitInterrupted(k)).toBe(true)
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('deriveSignalsFromStream 与 record 在 A 形态上等价（同源判据）', () => {
    const s = deriveSignalsFromStream({
      sawTerminalEvent: false, runFailed: false, sawWaitingUser: false,
      loopCompletedNaturally: true, turnRole: 'owner', promptAccepted: true,
      executionEvents: A_EVENTS,
    })
    expect(s).toEqual(deriveSignalsFromRecord(A_EVENTS, A_META))
  })

  // TS2783 暴露的测试盲区：两个 stream 用例此前都传 sawWaitingUser:false，
  // 从没验证「运行时观测值」是否真的进入 signals。规格 §5.1 要求 stream 用运行时
  // 变量（权威），且「落库投影不得反向驱动运行时决策」——事件里有无 waiting_user
  // 都不能覆盖 input.sawWaitingUser。曾因 ...signalsFromEvents() 排在显式字段之后
  // 被静默覆盖，编译期由 TS2783 报错、运行期却无测试拦截。
  it('★ 回归锁：stream 的 sawWaitingUser 取运行时变量，不得被事件重算覆盖', () => {
    const s = deriveSignalsFromStream({
      sawTerminalEvent: false, runFailed: false, sawWaitingUser: true,
      loopCompletedNaturally: true, turnRole: 'owner', promptAccepted: true,
      executionEvents: A_EVENTS, // 故意不含 waiting_user 事件
    })
    expect(s.sawWaitingUser).toBe(true)
    expect(classifyTurnEnd(s)).toBe('suspended')
    expect(shouldEmitInterrupted(classifyTurnEnd(s))).toBe(false)
  })

  it('★ 回归锁：事件里有 waiting_user{waiting} 也不得反向把 stream 判为挂起', () => {
    const s = deriveSignalsFromStream({
      sawTerminalEvent: false, runFailed: false, sawWaitingUser: false,
      loopCompletedNaturally: true, turnRole: 'owner', promptAccepted: true,
      executionEvents: [
        ...A_EVENTS,
        { type: 'waiting_user', data: { status: 'waiting' } },
      ],
    })
    expect(s.sawWaitingUser).toBe(false)
    expect(classifyTurnEnd(s)).toBe('interrupted')
  })

  it('★ 回归锁：record 适配器仍从事件末态取挂起（与 stream 来源不同但判据同源）', () => {
    const s = deriveSignalsFromRecord(
      [...A_EVENTS, { type: 'waiting_user', data: { status: 'waiting' } }],
      A_META,
    )
    expect(s.sawWaitingUser).toBe(true)
    expect(classifyTurnEnd(s)).toBe('suspended')
  })

  it('★ 回归锁：prompt 未被接受 ⇒ not_started，两动作 false（不得造假记录）', () => {
    const s = deriveSignalsFromStream({
      sawTerminalEvent: false, runFailed: false, sawWaitingUser: false,
      loopCompletedNaturally: true, turnRole: 'owner', promptAccepted: false,
      executionEvents: [],
    })
    const k = classifyTurnEnd(s)
    expect(k).toBe('not_started')
    expect(shouldEmitInterrupted(k)).toBe(false)
    expect(shouldReleaseHold(s, k)).toBe(false)
  })

  it('★ 判定顺序：not_started 优先于 detached（prompt 被拒 + 断连）', () => {
    const s = signals({ promptAccepted: false, loopCompletedNaturally: false })
    expect(classifyTurnEnd(s)).toBe('not_started')
  })

  it('failed 回合：runFailed=true ⇒ failed，两动作 false', () => {
    const s = signals({ sawTerminalEvent: true, runFailed: true })
    const k = classifyTurnEnd(s)
    expect(k).toBe('failed')
    expect(shouldEmitInterrupted(k)).toBe(false)
    expect(shouldReleaseHold(s, k)).toBe(false)
  })
})
