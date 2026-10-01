/** P1 回合状态行：running 实时秒数 / waiting 收口 / failed 人话摘要。 */

export interface TurnStatusLineInput {
  isStreaming: boolean
  turnStartedAt?: number
  now: number
  waiting: boolean
  lastFailed?: string
  /**
   * 阻塞等待中的工具名（来自 `waiting_user{status:"waiting"}` 事件，2026-10-01）。
   * propose_generation 的确认动作在**画布节点**上，文案必须点明去哪确认，
   * 否则用户只看到「等待你确认」也不知道要做什么。
   */
  waitingTool?: string | null
}

export type TurnStatusLine = { text: string; mode: 'running' | 'waiting' | 'failed' } | null

/** 回合状态行：running → 生成回复中 · Ns；waiting → 等待你确认（秒数冻结）；failed → 生成失败 · 原因。 */
export function turnStatusLine(input: TurnStatusLineInput): TurnStatusLine {
  if (input.isStreaming) {
    if (input.waiting) {
      return {
        text: input.waitingTool === 'propose_generation' ? '等待你在画布上确认生成' : '等待你确认',
        mode: 'waiting',
      }
    }
    const seconds = input.turnStartedAt != null
      ? Math.max(0, Math.floor((input.now - input.turnStartedAt) / 1000))
      : 0
    return { text: `生成回复中 · ${seconds}s`, mode: 'running' }
  }
  if (input.lastFailed) return { text: `生成失败 · ${input.lastFailed}`, mode: 'failed' }
  return null
}

/** waiting 收紧：propose pending_confirm 一票通过；文本片段类 chip 需静默 2s
 * （detectAgentChipSet 基于 assistantText 片段匹配，流式途中即可能命中——假阳性防线）。 */
const WAITING_TEXT_IDLE_MS = 2000
export function resolveWaiting(input: {
  isStreaming: boolean
  proposePendingConfirm: boolean
  chipSet: string | null
  textIdleMs: number
  /**
   * 阻塞等待中的工具（`waiting_user{status:"waiting"}`）——一票通过，无需文本静默。
   *
   * 存在理由（2026-10-01 生产实证）：阻塞式工具的 tool_result 要等**等待结束**才发，
   * 所以 `proposePendingConfirm`（靠 tool_result 置位）在等待期内恒为 false；
   * 只靠它 + 文本 chip 判定，整段等待期都会显示「生成回复中 · Ns」= 用户看到的卡死。
   */
  blockingWait?: { toolName?: string } | null
}): boolean {
  if (!input.isStreaming) return false
  if (input.blockingWait) return true
  if (input.proposePendingConfirm) return true
  return input.chipSet !== null && input.textIdleMs >= WAITING_TEXT_IDLE_MS
}

/** error → 人话（来源：SSE error 事件 data / 请求异常；禁用 JSON 工具摘要）。 */
export function failureReason(err: unknown): string {
  const status = (err as { status?: number } | null)?.status
  if (status === 401) return '渠道密钥无效'
  if (status === 403) return '渠道无权限'
  if (status === 429) return '额度或频率受限'
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '')
  if (/timeout|timed?\s*out|abort/i.test(msg)) return '上游响应超时'
  return '生成失败，请重试'
}
