/**
 * 对话轮次「自动续跑」的派发决策（批次 3.2）。
 *
 * ## 为什么是独立文件而不是复用 `recovery-dispatch.decider.ts`
 *
 * ⭐ **机制要复用，判据要分开**。
 *
 * `decideRecoveryDispatch`（生成失败回注）与本决策器**共用**同一套限流机制
 * （幂等键 / 每小时次数 / 同因连败降级 / 在线门），但**在线门的语义相反**：
 *
 * | 场景 | 用户在场 | 用户不在场 | 理由 |
 * |---|---|---|---|
 * | 生成失败回注 | **回注** | skip | 失败要当面告诉用户；人不在时说了也白说 |
 * | 对话轮次自动续跑 | **skip** | **续跑** | ⭐ 用户在场时他会自己说「继续」，别抢他的意图 |
 *
 * ⇒ 若把两者塞进同一个 `decideRecoveryDispatch`，那个函数的「在线」分支会变成
 * 「看场景决定」的双态逻辑 ⇒ 既有测试要跟着改，且新增场景时容易踩错分支。
 *
 * ⇒ 决策分开写、**限流常量与形态一致**（同一套口径、同一个 `MAX_PER_SESSION_PER_HOUR`），
 * 两者仍属同一「派发机制」家族。
 *
 * ## 与批次 1（回合连续性）的关系
 *
 * 批次 1 已经解决「**故障发生后**下一轮能接上」：
 * 中断时把「用户要什么 / 做到哪 / 卡在哪」记进 `turnState`，
 * 下一轮装配时作为**动态块**注入模型上下文（含「不道歉、不复盘」指导语）。
 *
 * 本批解决「**用户根本不用说「继续」**」：
 * 失败后自动**新开一轮**，那一轮自然吃到动态块 ⇒ 模型直接接着做。
 *
 * ⭐ 因此本决策器**不需要自己造注入内容** —— 复用 `turnState` 通道即可。
 *
 * ## ⛔ 明确不做
 *
 * - ⛔ **关键词识别「继续」**：要猜用户意图，「接着改那个组件」即失效；
 * - ⛔ **`lane.resume()` 自动续上游 LLM**：`cmv3zzid` 事故已证**阻塞 612 s**
 *   （`session-manager.ts:1351-1369`）⇒ 只走「**新开一轮**」；
 * - ⛔ **把上游 `pi.op.state` 断点接进对话主链路**：那是「工具级副作用」的恢复机制，
 *   与本问题（对话层失忆）是两件事。
 */

/** 派发路径。`newTurn` = 新开一轮（自动续跑只走这条）；`skip` = 不派发。 */
export type AutoResumePath = 'newTurn' | 'skip'

export interface AutoResumeInput {
  /**
   * 本轮是否以错误收束。
   * ⛔ **用户主动取消不算**（那是用户的意图，不是故障）⇒ 由调用方保证。
   */
  failed: boolean
  /**
   * 用户是否在场（在线代理：runs/events 旁听流 5 分钟窗口内见过）。
   * ⭐ **在场 ⇒ 不自动**（他会自己说「继续」，别抢）。
   */
  userOnline: boolean
  /**
   * 同一中断是否已派发过（幂等键，防同一轮重复触发）。
   */
  turnAlreadyDispatched: boolean
  /** 该会话最近一小时已自动续跑次数。 */
  sessionDispatchCountLastHour: number
  /**
   * 同一**会话**连续同原因失败次数（1=首次）。
   *
   * ⭐ 与「每会话每小时上限」是**互补**的两道防线，不是冗余：
   * - 限流是**短窗口**（1 小时内最多 1 次）⇒ 防刷屏；
   * - 连败是**长窗口**（累计 2 次就停）⇒ 跨过小时额度重置后仍拦得住
   *   ⇒ 故障持续时不会每小时自动重试一次。
   */
  sameThreadStreak: number
}

export interface AutoResumeDecision {
  path: AutoResumePath
  reason: string
  /** true = 同因连败降级：不再自动续跑（交回用户，避免无限重试）。 */
  degraded: boolean
}

/**
 * 每会话每小时最多自动续跑几次。
 *
 * ⭐ 与生成失败回注**同口径**（`recovery-dispatch.decider.ts` 的 `MAX_PER_SESSION_PER_HOUR`），
 * 但**取更严的值**：自动续跑会**真的再跑一轮 LLM**（消耗额度），
 * 而失败回注只是发一句话 ⇒ 自动续跑的上限应更低。
 */
export const MAX_AUTO_RESUME_PER_SESSION_PER_HOUR = 1

/** 同因连败达到该次数 ⇒ 降级（不再自动续跑，交回用户）。 */
export const SAME_THREAD_STREAK_DEGRADE = 2

/**
 * 对话轮次自动续跑的派发决策（纯函数）。
 *
 * ⭐ **顺序有意义**：
 * 1. 幂等最先（同一轮绝不派两次）；
 * 2. 非失败不派（用户取消不是故障）；
 * 3. **用户在场不派**（别抢用户的意图）；
 * 4. 限流；
 * 5. 连败降级。
 */
export function decideAutoResume(input: AutoResumeInput): AutoResumeDecision {
  if (input.turnAlreadyDispatched) {
    return { path: 'skip', reason: 'turn-already-dispatched', degraded: false }
  }
  if (!input.failed) {
    return { path: 'skip', reason: 'not-failed', degraded: false }
  }
  if (input.userOnline) {
    return { path: 'skip', reason: 'user-online', degraded: false }
  }
  if (input.sessionDispatchCountLastHour >= MAX_AUTO_RESUME_PER_SESSION_PER_HOUR) {
    return { path: 'skip', reason: 'session-rate-limited', degraded: false }
  }
  const degraded = input.sameThreadStreak >= SAME_THREAD_STREAK_DEGRADE
  if (degraded) {
    return { path: 'skip', reason: 'same-thread-streak', degraded: true }
  }
  return { path: 'newTurn', reason: 'auto-resume', degraded: false }
}
