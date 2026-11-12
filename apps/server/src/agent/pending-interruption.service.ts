/**
 * SSE 事件一等化 P2：待确认门 durable 化（spec §3.2 / 实施计划 §3）。
 *
 * 真源从「进程内 PendingToolRegistry + 10min 内存墓碑 + metadata 读时裁决」
 * 升级为持久化表：刷新 / 进程重启 / 换设备后门仍在；超时由 expiresAt 驱动；
 * status 由 CAS 单点翻转，终态门不再下发活卡片。
 *
 * 设计纪律：
 * - 全部方法 fail-open：表写失败只留痕不阻塞 SSE / /answers（与 appendAgentEvent 对称）；
 *   门状态读失败按「仍活」保守放行（未知门 ⇒ true），保证旧会话零回归。
 * - 不新起 timer：过期扫描挂既有 AutomationSchedulerService 的 1min job（G1 唯一 timer）。
 * - 不改 pi-runtime：其 setTimeout 仍负责让阻塞工具返回 timeout，本表只作**权威状态**，
 *   两路通过 waiting_user{resolved} 帧对齐。
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { AutomationSchedulerService } from '../automation/automation-scheduler.service'
import { PrismaService } from '../prisma/prisma.service'

export type GateStatus = 'pending' | 'answered' | 'expired' | 'aborted'

/** 卡片帧先于 waiting 帧到达时的兜底（保守取 15min；waiting 帧会覆写为精确 timeoutMs）。 */
export const DEFAULT_GATE_TTL_MS = 15 * 60_000
/** AutomationJob.handlerKey（与 AUTOMATION_DEFAULT_JOBS 种子一致）。 */
export const PENDING_INTERRUPTION_SWEEP_KEY = 'pending-interruption-sweep'

export interface PendingInterruptionSummary {
  callId: string
  kind: string
  questions: unknown[]
  expiresAt: number
  status: 'pending'
}

/**
 * W1c（2026-11-12 D1=A）：与 `pendingInterruption` 互补的「终态可见」摘要。
 * `pendingInterruption` 只返回仍可点的门（旧形状兼容，前端不改动即直通）；
 * `interruption` 返回本线程最新一条门（不限 status，按 createdAt desc），
 * 让前端在刷新 / 重连后能重建「已回答 / 已跳过 / 已超时」的终态卡（W1c-2）。
 * 语义独立、互不干扰：本类型与 `PendingInterruptionSummary` 并存，零迁移。
 */
export interface InterruptionSummary {
  callId: string
  kind: string
  questions: unknown[]
  expiresAt: number
  status: GateStatus
}

type GateRow = {
  id: string
  threadId: string
  callId: string
  kind: string
  questionsJson: string | null
  status: string
  expiresAt: Date
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

@Injectable()
export class PendingInterruptionService implements OnModuleInit {
  private readonly logger = new Logger(PendingInterruptionService.name)

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(AutomationSchedulerService)
    private readonly scheduler?: AutomationSchedulerService,
  ) {}

  onModuleInit(): void {
    this.scheduler?.registerHandler(PENDING_INTERRUPTION_SWEEP_KEY, async () => this.sweepExpired())
  }

  /**
   * 开闸：waiting_user{status:'waiting'}（精确 expiresAt）或
   * canvas_command{ask_user}（补题面）到达时调用。
   *
   * - 幂等：同 (threadId, callId) 重复帧只更新题面/runId；终态行**不复活**。
   * - expiresAt 只在显式传入时覆写（卡片帧兜底值不得覆盖 waiting 帧的精确值）。
   */
  async openGate(input: {
    threadId: string
    callId: string
    runId?: string | null
    kind?: string
    questions?: unknown
    /** epoch ms；显式给出时覆写既有行的过期时刻。 */
    expiresAt?: number
    ttlMs?: number
    startedAt?: number
  }): Promise<void> {
    if (!input.threadId || !input.callId) return
    const now = input.startedAt ?? Date.now()
    const expiresAt = new Date(input.expiresAt ?? now + (input.ttlMs ?? DEFAULT_GATE_TTL_MS))
    const questionsJson =
      input.questions === undefined ? undefined : JSON.stringify(input.questions ?? null)
    try {
      const key = { threadId_callId: { threadId: input.threadId, callId: input.callId } }
      const existing = (await this.prisma.pendingInterruption.findUnique({ where: key })) as GateRow | null
      if (existing) {
        if (existing.status !== 'pending') return // 终态不复活（P1c-4）
        await this.prisma.pendingInterruption.update({
          where: { id: existing.id },
          data: {
            ...(input.runId ? { runId: input.runId } : {}),
            ...(input.kind ? { kind: input.kind } : {}),
            ...(questionsJson !== undefined ? { questionsJson } : {}),
            ...(input.expiresAt !== undefined ? { expiresAt } : {}),
            updatedAt: new Date(now),
          },
        })
        return
      }
      await this.prisma.pendingInterruption.create({
        data: {
          threadId: input.threadId,
          callId: input.callId,
          runId: input.runId ?? null,
          kind: input.kind ?? 'ask_user',
          questionsJson: questionsJson ?? null,
          status: 'pending',
          expiresAt,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        },
      })
    } catch (err) {
      // 唯一键并发冲突 / 表不可用：fail-open，不阻塞事件流
      this.logger.warn(`pending_interruption_open_failed callId=${input.callId}: ${errMessage(err)}`)
    }
  }

  /**
   * CAS 裁决：只翻 pending 行 ⇒ 重复作答 / 并发第二发幂等，终态门绝不复活。
   * @returns 是否由本次请求完成翻转（count > 0）。
   */
  async settleGate(input: {
    threadId?: string
    callId: string
    status: Exclude<GateStatus, 'pending'>
    answerJson?: unknown
  }): Promise<boolean> {
    try {
      const res = await this.prisma.pendingInterruption.updateMany({
        where: {
          callId: input.callId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          status: 'pending',
        },
        data: {
          status: input.status,
          ...(input.answerJson !== undefined
            ? { answerJson: JSON.stringify(input.answerJson) }
            : {}),
          updatedAt: new Date(),
        },
      })
      return res.count > 0
    } catch (err) {
      this.logger.warn(`pending_interruption_settle_failed callId=${input.callId}: ${errMessage(err)}`)
      return false
    }
  }

  /** 定时扫描：过期未裁决门翻 expired；二次扫描 count=0（幂等）。 */
  async sweepExpired(nowMs = Date.now()): Promise<number> {
    try {
      const res = await this.prisma.pendingInterruption.updateMany({
        where: { status: 'pending', expiresAt: { lt: new Date(nowMs) } },
        data: { status: 'expired', updatedAt: new Date(nowMs) },
      })
      return res.count
    } catch (err) {
      this.logger.warn(`pending_interruption_sweep_failed: ${errMessage(err)}`)
      return 0
    }
  }

  /** state API：仅返回仍可点的门（pending 且未过 expiresAt）；无则 null（旧形状兼容）。 */
  async getPending(threadId: string, nowMs = Date.now()): Promise<PendingInterruptionSummary | null> {
    if (!this.prisma?.pendingInterruption) return null
    try {
      const row = (await this.prisma.pendingInterruption.findFirst({
        where: { threadId, status: 'pending', expiresAt: { gt: new Date(nowMs) } },
        orderBy: { createdAt: 'desc' },
      })) as GateRow | null
      if (!row) return null
      let questions: unknown[] = []
      try {
        const parsed = row.questionsJson ? JSON.parse(row.questionsJson) : []
        if (Array.isArray(parsed)) questions = parsed
      } catch {
        questions = []
      }
      return {
        callId: row.callId,
        kind: row.kind,
        questions,
        expiresAt: new Date(row.expiresAt).getTime(),
        status: 'pending',
      }
    } catch (err) {
      this.logger.warn(`pending_interruption_get_pending_failed thread=${threadId}: ${errMessage(err)}`)
      return null
    }
  }

  /**
   * W1c（D1=A）：返回本线程最新一条门（不限 status，按 createdAt desc）。
   * 与 `getPending`（仅活门）互补——前端用它重建终态卡，
   * `getPending` 保持不变以兼容旧前端形状。读失败 ⇒ null（fail-open，旧会话零回归）。
   */
  async getLatest(threadId: string, nowMs = Date.now()): Promise<InterruptionSummary | null> {
    if (!this.prisma?.pendingInterruption) return null
    try {
      const row = (await this.prisma.pendingInterruption.findFirst({
        where: { threadId },
        orderBy: { createdAt: 'desc' },
      })) as GateRow | null
      if (!row) return null
      let questions: unknown[] = []
      try {
        const parsed = row.questionsJson ? JSON.parse(row.questionsJson) : []
        if (Array.isArray(parsed)) questions = parsed
      } catch {
        questions = []
      }
      return {
        callId: row.callId,
        kind: row.kind,
        questions,
        expiresAt: new Date(row.expiresAt).getTime(),
        status: row.status as GateStatus,
      }
    } catch (err) {
      this.logger.warn(`pending_interruption_get_latest_failed thread=${threadId}: ${errMessage(err)}`)
      return null
    }
  }

  /** late answer / 一致性门控：门状态 + 过期时刻；无记录（老会话）⇒ null。 */
  async getGate(callId: string): Promise<{ status: string; expiresAt: number } | null> {
    try {
      const row = (await this.prisma.pendingInterruption.findFirst({
        where: { callId },
      })) as GateRow | null
      return row ? { status: row.status, expiresAt: new Date(row.expiresAt).getTime() } : null
    } catch (err) {
      this.logger.warn(`pending_interruption_get_gate_failed callId=${callId}: ${errMessage(err)}`)
      return null
    }
  }

  /**
   * 门是否仍活：无记录 / 读失败 ⇒ true（保守放行，旧会话零回归）；
   * 非 pending 或已过 expiresAt ⇒ false（终态门不下发活卡片）。
   */
  async isGateLive(callId: string, nowMs = Date.now()): Promise<boolean> {
    const gate = await this.getGate(callId)
    if (!gate) return true
    return gate.status === 'pending' && gate.expiresAt > nowMs
  }

  /** 历史重放批量门控：返回「终态或已过期」的 callId 集合。 */
  async getTerminalCallIds(callIds: string[], nowMs = Date.now()): Promise<Set<string>> {
    const terminal = new Set<string>()
    if (!callIds.length) return terminal
    try {
      const rows = (await this.prisma.pendingInterruption.findMany({
        where: { callId: { in: [...new Set(callIds)] } },
      })) as GateRow[]
      for (const row of rows) {
        if (row.status !== 'pending' || new Date(row.expiresAt).getTime() <= nowMs) {
          terminal.add(row.callId)
        }
      }
    } catch (err) {
      this.logger.warn(`pending_interruption_batch_gate_failed: ${errMessage(err)}`)
    }
    return terminal
  }
}
