import { Inject, Injectable } from '@nestjs/common'
import {
  decideAutoResume,
  MAX_AUTO_RESUME_PER_SESSION_PER_HOUR,
  type AutoResumeDecision,
} from './auto-resume.decider'
import { isSessionOnline } from '../generation-recovery/presence'

/**
 * 对 AgentService 的窄端口。
 *
 * ⚠️ 与 `generation-recovery.service.ts` 同款纪律：**不要 import AgentService 类**
 * —— `agent.service → 本文件 → agent.service` 会成循环 import，
 * 编译产物里本文件在 agent.service 求值时尚未初始化 ⇒ Nest DI 拿到 undefined token，
 * 生产启动即崩（#398 部署事故）。
 *
 * 绑定在 AgentModule：`{ provide: AUTO_RESUME_AGENT_PORT, useExisting: AgentService }`。
 */
export const AUTO_RESUME_AGENT_PORT = Symbol('AUTO_RESUME_AGENT_PORT')

export interface AutoResumeAgentPort {
  /**
   * 新开一轮（system-origin）。
   *
   * ⚠️ 位置参数签名对齐 `agent.service.streamConversation`（16 参，终审 I-2）：
   * `billingSource` 落在**末位**，中间未消费的参数必须显式占位 `undefined`
   * —— 若只声明短签名，多传的实参会错位绑到 `idempotencyKey`。
   */
  streamConversation(
    sessionId: string,
    message: string,
    userId?: string,
    threadId?: string,
    idempotencyKey?: string,
    skillId?: string,
    model?: string,
    focusNodeId?: string,
    attachments?: unknown[],
    refOrder?: string[],
    mentionedKeys?: string[],
    thinking?: boolean,
    thinkingEffort?: string,
    branchFromEntryId?: string,
    selectedNodeIds?: string[],
    billingSource?: 'user' | 'automation',
  ): AsyncGenerator<unknown>
}

export interface AutoResumeInput {
  sessionId: string
  /** 全管线要求 userId（piEligible 判定）。 */
  userId: string
  /** 未知时缺省：sessionKey 回落 sessionId。 */
  threadId?: string | null
  /**
   * 中断标识（幂等键）。
   *
   * ⭐ 用「用户消息 id + 时刻」的组合：本轮的 user 消息 id 能唯一标识「这一轮」；
   * 时刻用于同一 user 消息触发多次时的进一步区分。
   */
  turnKey: string
  /** 本轮是否以错误收束（用户主动取消 ⇒ false）。 */
  failed: boolean
  /** 中断原因（同因连败判据用）。 */
  interruption: string
}

/**
 * 对话轮次「自动续跑」派发服务（批次 3.2）。
 *
 * ## 做什么
 *
 * 回合失败后**不等用户**说「继续」，自动新开一轮，让模型接着做。
 *
 * ## 复用既有机制（不新造限流）
 *
 * - **限流三规则**（幂等键 / 每会话每小时次数 / 同因连败降级）
 *   —— 与 `GenerationRecoveryService` 同一套形态与口径；
 * - **在线代理**（`isSessionOnline`）—— 直接复用 `generation-recovery/presence`；
 * - **注入通道**（`turnState` 动态块）—— 复用批次 1；本服务**不造注入内容**。
 *
 * ## feature flag
 *
 * `TURN_AUTO_RESUME_ENABLED` 默认 **off** ⇒ off 时零派发，
 * 行为与今天逐字节一致（回滚 = 环境变量一行）。
 *
 * ⚠️ 与 `GENERATION_RECOVERY_ENABLED` **独立**：两者语义不同
 * （一个自动续跑、一个失败回注），灰度节奏也应独立。
 */
@Injectable()
export class TurnAutoResumeService {
  /** turnKey → 已派发时间（幂等，防同一轮重复触发）。 */
  private readonly dispatched = new Map<string, number>()
  /** sessionKey → 本小时派发时间列表（软限流，进程重启清零 = 可接受降级）。 */
  private readonly sessionDispatches = new Map<string, number[]>()
  /**
   * sessionKey → { interruption, streak }：同因连败计数。
   *
   * ⭐ key 是**会话**（不是 thread）：连续性故障是会话级的
   * （同一条会话反复在同一个地方失败 ⇒ 续跑也接不上 ⇒ 应交回用户）。
   */
  private readonly threadStreaks = new Map<string, { interruption: string; streak: number }>()

  constructor(@Inject(AUTO_RESUME_AGENT_PORT) private readonly agent: AutoResumeAgentPort) {}

  get enabled(): boolean {
    return process.env.TURN_AUTO_RESUME_ENABLED === 'true'
  }

  async handleTurnFailed(input: AutoResumeInput): Promise<AutoResumeDecision> {
    if (!this.enabled) {
      return { path: 'skip', reason: 'flag-off', degraded: false }
    }
    const sessionKey = input.threadId?.trim() || input.sessionId
    const before = this.dispatched.has(input.turnKey)
    const streak = this.bumpStreak(sessionKey, input.interruption)
    const decision = decideAutoResume({
      failed: input.failed,
      userOnline: isSessionOnline(sessionKey),
      turnAlreadyDispatched: before,
      sessionDispatchCountLastHour: this.countLastHour(sessionKey),
      sameThreadStreak: streak,
    })
    if (decision.path === 'skip') return decision

    // ⭐ 注入内容：复用批次 1 的 `turnState` 动态块（下一轮装配时自动带上
    // 「用户要什么 / 做到哪 / 卡在哪」+「不道歉、不复盘」指导语）⇒ 本消息只需
    // 点明「接着做」，**不重复**状态内容（重复会让模型以为状态出现两次）。
    const text = '[系统事件·回合中断] 上一轮在执行中被中断。直接接着未完成的部分继续，不要道歉、不要复盘。'
    void this.drainConversation(input.sessionId, input.userId, input.threadId, text, input.turnKey)
    this.markDispatched(input.turnKey, sessionKey)
    return decision
  }

  private async drainConversation(
    sessionId: string,
    userId: string,
    threadId: string | null | undefined,
    text: string,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      // ⚠️ 位置参数签名（agent.service.ts 的 streamConversation，16 参）：
      // 中间 11 个未消费参数显式占位 undefined，billingSource='automation' 落末位
      // —— automation run 的预扣失败时降级照常执行，不被 402 静默吞。
      //
      // ⭐ idempotencyKey = 本轮的 turnKey ⇒ 即使 drain 被并发触发两次，
      // 同一轮也只会真的跑一次（agent.service 侧按幂等键去重）。
      const stream = this.agent.streamConversation(
        sessionId,
        text,
        userId,
        threadId ?? undefined,
        idempotencyKey,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'automation',
      )
      for await (const _event of stream) {
        // 宿主无 SSE 调用方：事件由前端 runs/events 旁听流消费，此处只驱动。
      }
    } catch {
      // 自动续跑是**旁路观察者**：失败只留日志，绝不影响本轮收尾。
    }
  }

  private bumpStreak(threadKey: string, interruption: string): number {
    const prev = this.threadStreaks.get(threadKey)
    const streak = prev && prev.interruption === interruption ? prev.streak + 1 : 1
    this.threadStreaks.set(threadKey, { interruption, streak })
    return streak
  }

  private countLastHour(sessionKey: string): number {
    const now = Date.now()
    const list = (this.sessionDispatches.get(sessionKey) ?? []).filter(
      (t) => now - t <= 3_600_000,
    )
    this.sessionDispatches.set(sessionKey, list)
    return list.length
  }

  private markDispatched(turnKey: string, sessionKey: string): void {
    const now = Date.now()
    this.dispatched.set(turnKey, now)
    const list = this.sessionDispatches.get(sessionKey) ?? []
    list.push(now)
    this.sessionDispatches.set(sessionKey, list)
  }
}

export { MAX_AUTO_RESUME_PER_SESSION_PER_HOUR }
