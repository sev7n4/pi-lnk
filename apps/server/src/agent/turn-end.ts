/**
 * 回合终态单一判据（spec docs/superpowers/specs/2026-11-11-subagent-result-delivery-design.md §5.1）。
 *
 * 生产事故（2026-11-11，会话 cmwbvfp4p000qrk01pch77w13）：上游 SSE 迭代器自然耗尽、
 * 从未收到 agent_end/error，Nest 侧把它当成正常收尾（扣 1 积分 + 补 [DONE]）⇒ 用户
 * 看到「派生子代理 ✓ 用时 0ms」却没有任何结果。本模块把「完成」从连接存活度里
 * 拿出来，改为对可观测信号的一次显式分类，供 SSE 下发 / 计费 / 落库同源消费。
 *
 * ⚠️ 判定顺序不可调换：断连可能发生在已见 agent_end 之后。
 * ⚠️ 落库投影（deriveSignalsFromRecord）只用于求值/守卫，不得反向驱动运行时决策。
 */
export interface TraceEventLike {
  type: string
  data?: unknown
  seq?: number
  gSeq?: number
}

export interface TurnEndSignals {
  sawTerminalEvent: boolean
  runFailed: boolean
  sawWaitingUser: boolean
  loopCompletedNaturally: boolean
  isOwner: boolean
  /** prompt 是否被 pi 接受。false ⇒ pi 侧整轮不存在，不得发中断事件/造记录。 */
  promptAccepted: boolean
  hasTurnUsage: boolean
  hasOutstandingToolCall: boolean
}

export type TurnEndKind =
  | 'completed' | 'failed' | 'suspended' | 'detached' | 'shadow' | 'not_started' | 'interrupted'

/** tool_call 的 toolCallId 减去已配对 tool_result 的 toolCallId（保序去重）。 */
export function outstandingToolCallIds(events: readonly TraceEventLike[]): string[] {
  const calls: string[] = []
  const results = new Set<string>()
  for (const e of events) {
    const id = (e.data as { toolCallId?: unknown } | undefined)?.toolCallId
    if (typeof id !== 'string' || !id) continue
    if (e.type === 'tool_call') calls.push(id)
    else if (e.type === 'tool_result') results.add(id)
  }
  const seen = new Set<string>()
  return calls.filter((id) => {
    if (results.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** 末态为 waiting{waiting} 才算挂起；同流内 resolved（answered/超时）复位。 */
function waitingStillPending(events: readonly TraceEventLike[]): boolean {
  let pending = false
  for (const e of events) {
    if (e.type !== 'waiting_user') continue
    pending = (e.data as { status?: unknown } | undefined)?.status === 'waiting'
  }
  return pending
}

export function classifyTurnEnd(s: TurnEndSignals): TurnEndKind {
  if (!s.isOwner) return 'shadow'
  // ⚠️ 必须排在 loopCompletedNaturally 之前：prompt 被上游拒绝时 pi 侧整轮
  // 不存在，流同样会自然耗尽。若此时合成 turn_interrupted 并 pushTraceEvent，
  // executionEvents 非空 ⇒ hasContent=true ⇒ finalizeTurn 造出一条假 assistant 行
  // （既有回归锁 turn-settle-detached.test.ts「不造假记录」实锤）。
  if (!s.promptAccepted) return 'not_started'
  if (!s.loopCompletedNaturally) return 'detached'
  if (s.sawTerminalEvent) return s.runFailed ? 'failed' : 'completed'
  if (s.sawWaitingUser) return 'suspended'
  return 'interrupted'
}

export function shouldEmitInterrupted(k: TurnEndKind): boolean {
  return k === 'interrupted'
}

/**
 * 窄动作判据：只有「真的什么都没交付」才退费。
 *
 * 全库 metadata.truncated 有 82 条，混着 Nest 提前收尾、pi 侧继续跑完并经
 * followUp tail 续传的正常长回合 ⇒ 不能按 !sawTerminalEvent 一律 release，
 * 否则误伤这些回合（少收费）并把正常长回合永久钉成失败。
 */
export function shouldReleaseHold(s: TurnEndSignals, k: TurnEndKind): boolean {
  return (
    k === 'interrupted' &&
    !s.hasTurnUsage &&
    s.hasOutstandingToolCall &&
    !s.runFailed &&
    s.isOwner
  )
}

/**
 * 只负责两个**纯事件派生**字段。
 * ⚠️ 不要在这里返回 sawWaitingUser：两个适配器的来源不同（stream = 运行时观测变量，
 * record = 落库事件末态），若放进本函数的返回值再 spread，会把 stream 的显式
 * input.sawWaitingUser 静默覆盖（TS2783 + 规格 §5.1「落库投影不得反向驱动运行时决策」）。
 */
function signalsFromEvents(events: readonly TraceEventLike[]): Pick<
  TurnEndSignals, 'hasTurnUsage' | 'hasOutstandingToolCall'
> {
  return {
    hasTurnUsage: events.some((e) => e.type === 'turn_usage'),
    hasOutstandingToolCall: outstandingToolCallIds(events).length > 0,
  }
}

/** 运行时适配器：streamConversation 循环出口调用一次，结算块复用同一份 signals。 */
export function deriveSignalsFromStream(input: {
  sawTerminalEvent: boolean
  runFailed: boolean
  sawWaitingUser: boolean
  loopCompletedNaturally: boolean
  turnRole: 'owner' | 'shadow'
  promptAccepted: boolean
  executionEvents: readonly TraceEventLike[]
}): TurnEndSignals {
  return {
    sawTerminalEvent: input.sawTerminalEvent,
    runFailed: input.runFailed,
    sawWaitingUser: input.sawWaitingUser,
    loopCompletedNaturally: input.loopCompletedNaturally,
    isOwner: input.turnRole === 'owner',
    promptAccepted: input.promptAccepted,
    ...signalsFromEvents(input.executionEvents),
  }
}

/** 记录适配器：贴生产记录求值、静态守卫、故障注入判据。 */
export function deriveSignalsFromRecord(
  events: readonly TraceEventLike[],
  metadata: { truncated?: boolean },
): TurnEndSignals {
  return {
    // truncated 正是 !sawTerminalEvent 的落库投影（键不出现纪律）
    sawTerminalEvent: metadata.truncated !== true,
    runFailed: events.some((e) => e.type === 'error'),
    sawWaitingUser: waitingStillPending(events),
    // 能落成 assistant 消息的 owner 回合即自然收尾；断连兜底走 void finalizeTurn，
    // 不进入本判据的求值域。
    loopCompletedNaturally: true,
    isOwner: true,
    // 已落库 ⇒ prompt 必然被接受过（prompt 被拒时 finalizeTurn 不写行）。
    promptAccepted: true,
    ...signalsFromEvents(events),
  }
}
