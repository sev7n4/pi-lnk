export type DispatchPath = 'followUp' | 'newTurn' | 'skip'

export interface DispatchInput {
  /** 该会话当前有活跃 run（Nest 侧会话状态）。 */
  hasActiveRun: boolean
  /** 在线代理判据：runs/events lastSeenAt 在 5 分钟窗口内（spec §6.0-1）。 */
  userOnline: boolean
  /** 同一 generationRecordId 是否已派发过（幂等键，防 poll+catch 双发射）。 */
  recordIdDispatchedBefore: boolean
  /** 该 session 最近一小时已派发次数。 */
  sessionDispatchCountLastHour: number
  /** 同一 nodeId 连续同 errorCode 失败次数（1=首次）。 */
  sameCodeStreak: number
}

export interface DispatchDecision {
  path: DispatchPath
  reason: string
  /** true = 同因连败降级：只发一句话简报，不展开选项。 */
  briefOnly: boolean
}

const MAX_PER_SESSION_PER_HOUR = 2
const SAME_CODE_STREAK_BRIEF = 2

export function decideRecoveryDispatch(input: DispatchInput): DispatchDecision {
  if (input.recordIdDispatchedBefore) {
    return { path: 'skip', reason: 'record-already-dispatched', briefOnly: false }
  }
  if (!input.userOnline) {
    return { path: 'skip', reason: 'user-offline', briefOnly: false }
  }
  if (input.sessionDispatchCountLastHour >= MAX_PER_SESSION_PER_HOUR) {
    return { path: 'skip', reason: 'session-rate-limited', briefOnly: false }
  }
  const briefOnly = input.sameCodeStreak >= SAME_CODE_STREAK_BRIEF
  if (input.hasActiveRun) {
    return { path: 'followUp', reason: briefOnly ? 'active-run-brief' : 'active-run', briefOnly }
  }
  return { path: 'newTurn', reason: briefOnly ? 'idle-brief' : 'idle', briefOnly }
}
