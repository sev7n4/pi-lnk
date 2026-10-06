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
  /**
   * 阻塞题干（ask_user 经 waiting_user 事件的 meta.questionTitle 下发，2026-10-02）。
   * 与 waitingTool 的分工：propose_generation 的确认动作在画布上（去哪确认靠节点），
   * ask_user 卡在聊天侧、题面就是全部信息 —— 空着只会显示一句无信息量的「等待你确认」。
   */
  waitingQuestion?: string | null
  /** 阻塞等待的自动取消时刻（epoch ms）；到点前显示「还剩 N 分钟自动取消」（决策 6）。 */
  waitingDeadline?: number | null
  /** 「正在做什么」人话（来自最新执行步骤）；缺失时退化为 GENERIC_ACTIVITY（决策 3 / 5）。 */
  activity?: string | null
}

export type TurnStatusLine = {
  text: string
  /** 次行信息（倒计时 / 后续提示）；undefined 时模板不渲染次行。 */
  hint?: string
  mode: 'running' | 'waiting' | 'failed'
} | null

/** 缺省活动主语：注册表与 trace 都拿不到人话时的兜底，禁止把内部工具名吐给用户（决策 5）。 */
export const GENERIC_ACTIVITY = '处理中'

/** 剩余等待时间人话：≥60s 显示「还剩 N 分钟自动取消」，<60s 精确到秒。 */
export function waitHint(deadline: number | null | undefined, now: number): string | null {
  if (deadline == null) return null
  const left = Math.max(0, Math.ceil((deadline - now) / 1000))
  if (left <= 0) return '即将自动取消'
  if (left < 60) return `${left}s 后自动取消`
  return `还剩 ${Math.ceil(left / 60)} 分钟自动取消`
}

/** 回合状态行：running → <正在做的事> · Ns；waiting → 等待你确认 + 取消倒计时；failed → 生成失败 · 原因。 */
export function turnStatusLine(input: TurnStatusLineInput): TurnStatusLine {
  if (input.isStreaming) {
    if (input.waiting) {
      // 题面过长只留前 24 字 + 省略号：状态行是一行，塞进整段题目会把倒计时挤掉
      const question = input.waitingQuestion?.trim()
      const text = input.waitingTool === 'propose_generation'
        ? '等待你在画布上确认生成'
        : question
          ? `等待你作答：${question.length > 24 ? `${question.slice(0, 24)}…` : question}`
          : '等待你确认'
      // hint 为 undefined 时让 key 消失（模板 `v-if` 与既有 toEqual 断言都按「缺 key」理解）
      return {
        text,
        hint: waitHint(input.waitingDeadline, input.now) || undefined,
        mode: 'waiting',
      }
    }
    const seconds = input.turnStartedAt != null
      ? Math.max(0, Math.floor((input.now - input.turnStartedAt) / 1000))
      : 0
    const subject = input.activity?.trim() ? input.activity : '生成回复中'
    return { text: `${subject} · ${seconds}s`, mode: 'running' }
  }
  if (input.lastFailed) return { text: `生成失败 · ${input.lastFailed}`, mode: 'failed' }
  return null
}

/**
 * waiting 收紧：两种「确定在等」的信号各自一票通过。
 *
 * 2026-10-06：原先还有第三路 ——「assistantText 片段嗅探出的 chipSet + 文本静默 ≥2s」，
 * 那是为确认卡片（gate → chipSet → 确认/取消按钮）做的假阳性防线。确认卡片整体下线后
 * 该路已无输入源，一并删除（`WAITING_TEXT_IDLE_MS` 随之移除）。
 */
export function resolveWaiting(input: {
  isStreaming: boolean
  proposePendingConfirm: boolean
  /**
   * 阻塞等待中的工具（`waiting_user{status:"waiting"}`）——一票通过，无需文本静默。
   *
   * 存在理由（2026-10-01 生产实证）：阻塞式工具的 tool_result 要等**等待结束**才发，
   * 所以 `proposePendingConfirm`（靠 tool_result 置位）在等待期内恒为 false；
   * 只靠它判定，整段等待期都会显示「生成回复中 · Ns」= 用户看到的卡死。
   */
  blockingWait?: { toolName?: string } | null
}): boolean {
  if (!input.isStreaming) return false
  if (input.blockingWait) return true
  return input.proposePendingConfirm
}

/** error → 人话（来源：SSE error 事件 data / 请求异常；禁用 JSON 工具摘要）。 */
export function failureReason(err: unknown): string {
  const status = (err as { status?: number } | null)?.status
  if (status === 402) return '渠道余额不足'
  if (status === 401) return '渠道密钥无效'
  if (status === 403) return '渠道无权限'
  if (status === 429) return '额度或频率受限'
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '')
  if (/timeout|timed?\s*out|abort/i.test(msg)) return '上游响应超时'
  return '生成失败，请重试'
}
