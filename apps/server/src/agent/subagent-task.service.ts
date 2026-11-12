/**
 * D2 子代理一等任务单据（spec §5.2/§5.3）。
 *
 * 设计纪律（与 P2 PendingInterruptionService 同族）：
 * - 全部方法 fail-open：表写失败只留痕不阻塞 SSE；读失败按「无在途」保守返回 []。
 * - 不新起 timer：过期扫描挂既有 AutomationSchedulerService 的 1min job（G1 唯一 timer）。
 * - 不改 pi-runtime：Nest 侧权威状态由 tool_call / tool_result / turn_interrupted 三类帧驱动。
 * - 单据是 Nest 观测投影，不是子 run 内部真源 ⇒ reason 恒为可观测事实。
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { AutomationSchedulerService } from '../automation/automation-scheduler.service'
import { PrismaService } from '../prisma/prisma.service'
import {
  interruptedOutcome, isSpawnToolFrame, parseSubagentOutcome,
  type SubagentTaskOutcome,
} from './subagent-task.status'

export const SUBAGENT_TASK_SWEEP_KEY = 'subagent-task-sweep'
/** 300s 子任务硬边界 + 60s 宽限（不与 pi-runtime 共享代码，独立常量）。 */
export const SUBAGENT_TASK_TTL_MS = 360_000
const PREVIEW_MAX = 512

export interface SubagentTaskSummary {
  callId: string
  status: string
  reason: string | null
  taskPreview: string | null
  startedAt: number
  endedAt: number | null
}

type TaskRow = {
  callId: string
  status: string
  reason: string | null
  taskPreview: string | null
  startedAt: Date
  endedAt: Date | null
  expiresAt: Date
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

@Injectable()
export class SubagentTaskService implements OnModuleInit {
  private readonly logger = new Logger(SubagentTaskService.name)

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(AutomationSchedulerService)
    private readonly scheduler?: AutomationSchedulerService,
  ) {}

  onModuleInit(): void {
    this.scheduler?.registerHandler(SUBAGENT_TASK_SWEEP_KEY, async () => this.sweepExpired())
  }

  /** 漏斗唯一入口。非 spawn 帧立即返回 ⇒ 零 prisma 触达（性能回归锁）。 */
  onTraceEvent(
    ev: { type: string; data?: unknown },
    ctx: { threadId: string; runId?: string | null; parentSessionKey?: string | null },
  ): void {
    const d = (ev.data ?? {}) as Record<string, unknown>
    if (ev.type === 'tool_call' && isSpawnToolFrame(ev)) {
      const callId = d.toolCallId
      if (typeof callId !== 'string' || !callId) return
      const args = (d.args ?? {}) as Record<string, unknown>
      void this.openTask({
        threadId: ctx.threadId,
        callId,
        runId: ctx.runId,
        parentSessionKey: ctx.parentSessionKey,
        taskPreview: typeof args.task === 'string' ? args.task.slice(0, PREVIEW_MAX) : null,
      })
      return
    }
    if (ev.type === 'tool_result' && isSpawnToolFrame(ev)) {
      const callId = d.toolCallId
      if (typeof callId !== 'string' || !callId) return
      const outcome = parseSubagentOutcome(d.result)
      if (outcome) void this.settleTask({ callId, outcome })
      return
    }
    if (ev.type === 'turn_interrupted') {
      const ids = d.outstandingToolCallIds
      if (!Array.isArray(ids)) return
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue
        void this.settleTask({ callId: id, outcome: interruptedOutcome('no_terminal_event') })
      }
    }
  }

  async openTask(input: {
    threadId: string
    callId: string
    runId?: string | null
    parentSessionKey?: string | null
    taskPreview?: string | null
    startedAt?: number
  }): Promise<void> {
    if (!input.threadId || !input.callId) return
    const now = input.startedAt ?? Date.now()
    const requestId = `subagent:${input.callId}`
    try {
      const key = { threadId_callId: { threadId: input.threadId, callId: input.callId } }
      const existing = await this.prisma.subagentTask.findUnique({ where: key })
      if (existing || await this.prisma.subagentTask.findUnique({ where: { requestId } })) return
      await this.prisma.subagentTask.create({
        data: {
          threadId: input.threadId,
          callId: input.callId,
          requestId,
          runId: input.runId ?? null,
          parentSessionKey: input.parentSessionKey ?? null,
          taskPreview: input.taskPreview ?? null,
          status: 'spawned',
          expiresAt: new Date(now + SUBAGENT_TASK_TTL_MS),
          startedAt: new Date(now),
          updatedAt: new Date(now),
        },
      })
    } catch (err) {
      // 唯一键并发冲突 / 表不可用：fail-open，不阻塞事件流
      this.logger.warn(`subagent_task_open_failed callId=${input.callId}: ${errMessage(err)}`)
    }
  }

  /** CAS 单点：只翻 spawned ⇒ 重复 tool_result / sweep 竞态 / 终态复活全部挡住。 */
  async settleTask(input: { callId: string; outcome: SubagentTaskOutcome }): Promise<boolean> {
    try {
      const res = await this.prisma.subagentTask.updateMany({
        where: { callId: input.callId, status: 'spawned' },
        data: {
          status: input.outcome.status,
          reason: input.outcome.reason,
          outcomeJson: JSON.stringify(input.outcome.summary),
          endedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      return res.count > 0
    } catch (err) {
      this.logger.warn(`subagent_task_settle_failed callId=${input.callId}: ${errMessage(err)}`)
      return false
    }
  }

  /** 1min 扫描：过期未裁决单据翻 interrupted；二次扫描 count=0（幂等）。 */
  async sweepExpired(nowMs = Date.now()): Promise<number> {
    try {
      const res = await this.prisma.subagentTask.updateMany({
        where: { status: 'spawned', expiresAt: { lt: new Date(nowMs) } },
        data: {
          status: 'interrupted',
          reason: 'lease_expired',
          endedAt: new Date(nowMs),
          updatedAt: new Date(nowMs),
        },
      })
      return res.count
    } catch (err) {
      this.logger.warn(`subagent_task_sweep_failed: ${errMessage(err)}`)
      return 0
    }
  }

  /** state API：在途（spawned 且未过期） + 最近 5 条终态，字段裁剪、旧形状兼容。 */
  async getSummaries(threadId: string, nowMs = Date.now()): Promise<SubagentTaskSummary[]> {
    if (!this.prisma?.subagentTask) return []
    try {
      const rows = (await this.prisma.subagentTask.findMany({
        where: { threadId },
        orderBy: { startedAt: 'desc' },
      })) as TaskRow[]
      const live = rows.filter((r) => r.status === 'spawned' && r.expiresAt > new Date(nowMs))
      const terminal = rows.filter((r) => r.status !== 'spawned').slice(0, 5)
      return [...live, ...terminal].map((r) => ({
        callId: r.callId,
        status: r.status,
        reason: r.reason,
        taskPreview: r.taskPreview,
        startedAt: new Date(r.startedAt).getTime(),
        endedAt: r.endedAt ? new Date(r.endedAt).getTime() : null,
      }))
    } catch (err) {
      this.logger.warn(`subagent_task_summaries_failed thread=${threadId}: ${errMessage(err)}`)
      return []
    }
  }
}
