import { Injectable } from '@nestjs/common'
import { AgentService } from '../agent.service'
import { decideRecoveryDispatch, type DispatchDecision } from './recovery-dispatch.decider'
import { isSessionOnline } from './presence'

export interface GenerationFailedInput {
  sessionId: string
  /** streamConversation 全管线要求 userId（piEligible 判定）。 */
  userId: string
  /** 未知时缺省：sessionKey 回落 sessionId（Review Focus：语义由 service 测试钉住）。 */
  threadId?: string | null
  nodeId: string
  nodeTitle?: string
  generationRecordId: string
  errorCode?: string
  userMessage: string
  refundedPoints?: number
  /**
   * 测试/编排注入。生产发射点（waitVideoGeneration）**恒 false**：
   * Nest 侧没有活跃 run 查询，而 streamConversation 内置 409→steer durable 兜底
   * （agent.service.ts「409 = 上一轮还在跑」分支），活跃 run 场景消息延后不丢失。
   */
  hasActiveRun?: boolean
}

/**
 * 生成失败 Agent 回注服务（spec §6，PR3）。
 *
 * 旁路观察者：任何自身失败都不得影响画布收敛（节点 error 态已先落成）。
 * 限流三规则：recordId 幂等 / 每 session 每小时 2 次 / 同因连败降级简报。
 * feature flag `GENERATION_RECOVERY_ENABLED` 默认 off —— off 时零派发，
 * 行为与今天逐字节一致（回滚 = 环境变量一行）。
 */
@Injectable()
export class GenerationRecoveryService {
  /** recordId → 已派发时间（幂等，防 poll+catch 双发射）。 */
  private readonly dispatched = new Map<string, number>()
  /** sessionKey → 本小时派发时间列表（软限流，进程重启清零=可接受降级，遥测可见）。 */
  private readonly sessionDispatches = new Map<string, number[]>()
  /** nodeId → { errorCode, streak }：同因连败计数（spec §6.3 降级简报判据）。 */
  private readonly nodeCodeStreaks = new Map<string, { errorCode: string; streak: number }>()

  constructor(private readonly agent: AgentService) {}

  get enabled(): boolean {
    return process.env.GENERATION_RECOVERY_ENABLED === 'true'
  }

  async handleGenerationFailed(input: GenerationFailedInput): Promise<DispatchDecision> {
    if (!this.enabled) {
      return { path: 'skip', reason: 'flag-off', briefOnly: false }
    }
    const sessionKey = input.threadId?.trim() || input.sessionId
    const before = this.dispatched.has(input.generationRecordId)
    const streak = this.bumpStreak(input.nodeId, input.errorCode ?? 'unknown')
    const decision = decideRecoveryDispatch({
      hasActiveRun: input.hasActiveRun ?? false,
      userOnline: isSessionOnline(sessionKey),
      recordIdDispatchedBefore: before,
      sessionDispatchCountLastHour: this.countLastHour(sessionKey),
      sameCodeStreak: streak,
    })
    if (decision.path === 'skip') return decision

    const text = this.buildMessage(input, decision.briefOnly)
    if (decision.path === 'followUp') {
      await this.agent.followUpPiRun({
        sessionId: input.sessionId,
        threadId: input.threadId ?? undefined,
        text,
      })
    } else {
      // system-origin 新 turn：驱动既有 streamConversation 全管线（历史/retention/
      // finalizeTurn/persistCanvasEntities），drain 即跑完；事件经前端常驻 runs/events
      // 旁听流到达浏览器（pi-runtime subscribeLive 是多订户广播）。
      void this.drainConversation(input.sessionId, input.userId, input.threadId, text)
    }
    this.markDispatched(input.generationRecordId, sessionKey)
    return decision
  }

  private async drainConversation(
    sessionId: string,
    userId: string,
    threadId: string | null | undefined,
    text: string,
  ): Promise<void> {
    try {
      // ⚠️ 位置参数签名（agent.service.ts:222）：(sessionId, userMessage, userId, threadId)。
      const stream = this.agent.streamConversation(sessionId, text, userId, threadId ?? undefined)
      for await (const _event of stream) {
        // 宿主无 SSE 调用方：事件由前端 runs/events 旁听流消费（见上），此处只驱动。
      }
    } catch {
      // 回注是旁路观察者：失败只留日志，绝不影响画布收敛（节点 error 态已先落成）。
    }
  }

  private bumpStreak(nodeId: string, errorCode: string): number {
    const prev = this.nodeCodeStreaks.get(nodeId)
    const streak = prev && prev.errorCode === errorCode ? prev.streak + 1 : 1
    this.nodeCodeStreaks.set(nodeId, { errorCode, streak })
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

  private markDispatched(recordId: string, sessionKey: string): void {
    const now = Date.now()
    this.dispatched.set(recordId, now)
    const list = this.sessionDispatches.get(sessionKey) ?? []
    list.push(now)
    this.sessionDispatches.set(sessionKey, list)
  }

  private buildMessage(input: GenerationFailedInput, briefOnly: boolean): string {
    const head = `[系统事件·生成失败] node=${input.nodeId} record=${input.generationRecordId} reason=${input.errorCode ?? 'unknown'} detail=${input.userMessage} refund=${input.refundedPoints != null ? `已退回 ${input.refundedPoints} 积分` : 'none'}`
    if (briefOnly) {
      return `${head}\n请用一句话向用户说明失败原因与退款状态。`
    }
    return `${head}\n请：① 用一句话向用户说明失败原因与退款状态；② 给出下一步选项（改参数重试 / 换模型 / 放弃）；不要对该节点调用 run_*，等待用户选择。`
  }
}
