import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/** 运行触发原因（spec §4.1；'scheduled'→业务服务内部映射为 'periodic'，D4）。 */
export type AutomationRunReason = 'scheduled' | 'manual' | 'startup'
export interface AutomationRunContext {
  runId: string
  reason: AutomationRunReason
}
export type AutomationHandler = (params: Record<string, unknown>, ctx: AutomationRunContext) => Promise<unknown>
export type TriggerResult = { runId: string } | { skipped: true }

/** tick 周期：60s。interval 最小粒度 1 分钟 ⇒ tick 粒度足够。 */
const TICK_INTERVAL_MS = 60_000
/** startup run 统一延迟（原 reaper STARTUP_SWEEP_DELAY_MS 同值）。 */
export const STARTUP_RUN_DELAY_MS = 15_000

/** P0 默认 job 种子（create-if-missing，D5）。interval 默认值=迁移前生产行为。 */
export const AUTOMATION_DEFAULT_JOBS = [
  {
    id: 'job-upstream-probe',
    name: '上游模型探活对账',
    description: '对账各上游 /v1/models 与平台目录镜像（原 UpstreamProbeService 内置 interval，默认 6h）',
    handlerKey: 'upstream-probe',
    intervalMinutes: 360,
    runOnStartup: true,
    params: '{}',
  },
  {
    id: 'job-generation-reaper',
    name: '卡死生成记录回收',
    description: '回收超时 generating 记录并退款（原 GenerationReaperService 内置 interval 5min + 15s 启动首扫）',
    handlerKey: 'generation-reaper',
    intervalMinutes: 5,
    runOnStartup: true,
    params: '{}',
  },
] as const

type AutomationJobRow = Awaited<ReturnType<PrismaService['automationJob']['findUniqueOrThrow']>>

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * C5 Automations 统一调度器（spec docs/superpowers/specs/2026-10-11-automations-design.md）。
 *
 * 进程内唯一 timer 持有者（G1）：60s tick 检查到期 job 并派发；job 执行 fire-and-forget，
 * 绝不阻塞 bootstrap。并发权威 = 进程内 running Map（§6-1 单实例约束）。
 * handler 代码级注册（业务服务 onModuleInit 调 registerHandler）；开关/间隔/参数配置级（DB）。
 */
@Injectable()
export class AutomationSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AutomationSchedulerService.name)
  private readonly handlers = new Map<string, AutomationHandler>()
  /** jobId → runId（'pending' 为同步占位，D8）。并发权威。 */
  private readonly running = new Map<string, string>()
  private timer?: ReturnType<typeof setInterval>
  private readonly startupTimers: ReturnType<typeof setTimeout>[] = []
  /** 已排过 startup run 的 jobId（start() 幂等：重复调用不重复派发）。 */
  private readonly startupScheduled = new Set<string>()
  private readonly nowFn: () => number
  private readonly startupDelayMs: number

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() opts?: { now?: () => number; startupDelayMs?: number },
  ) {
    this.nowFn = opts?.now ?? (() => Date.now())
    this.startupDelayMs = opts?.startupDelayMs ?? STARTUP_RUN_DELAY_MS
  }

  registerHandler(handlerKey: string, handler: AutomationHandler): void {
    this.handlers.set(handlerKey, handler)
  }

  /** Nest 生命周期：测试环境零 timer（§6-3），但 tick/triggerManual 仍可用。 */
  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return
    void this.start().catch((err) => this.logger.error(`[automation] start 失败: ${errMessage(err)}`))
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const t of this.startupTimers) clearTimeout(t)
    this.startupTimers.length = 0
  }

  /**
   * 启动：种子默认 job（create-if-missing）→ 挂 tick timer（unref）→ 派发 startup run。
   * 幂等：重复调用不叠加 timer / 不重复 startup（测试钉住）。
   */
  async start(): Promise<void> {
    await this.ensureDefaultJobs()
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(this.nowFn()), TICK_INTERVAL_MS)
      this.timer.unref?.()
    }
    const jobs = await this.prisma.automationJob.findMany({ where: { enabled: true, runOnStartup: true } })
    for (const job of jobs) {
      if (this.startupScheduled.has(job.id)) continue
      this.startupScheduled.add(job.id)
      const t = setTimeout(() => {
        void this.dispatch(job, 'startup').catch((err) =>
          this.logger.error(`[automation] startup run ${job.id} 派发失败: ${errMessage(err)}`),
        )
      }, this.startupDelayMs)
      t.unref?.()
      this.startupTimers.push(t)
    }
    if (jobs.length > 0) {
      this.logger.log(`[automation] 已排定 ${jobs.length} 个 startup run（延迟 ${this.startupDelayMs}ms）`)
    }
  }

  /** 种子：只 create-if-missing（upsert update 空），绝不覆盖运维调过的配置（D5）。 */
  private async ensureDefaultJobs(): Promise<void> {
    for (const seed of AUTOMATION_DEFAULT_JOBS) {
      await this.prisma.automationJob.upsert({
        where: { id: seed.id },
        create: {
          id: seed.id,
          name: seed.name,
          description: seed.description,
          handlerKey: seed.handlerKey,
          enabled: true,
          scheduleType: 'interval',
          intervalMinutes: seed.intervalMinutes,
          params: seed.params,
          concurrencyPolicy: 'forbid',
          runOnStartup: seed.runOnStartup,
        },
        update: {},
      })
    }
  }

  /** tick：查 enabled interval job → due 判定（D7）→ 派发。单 job 异常不拖垮其余。 */
  async tick(nowMs: number): Promise<void> {
    let jobs
    try {
      jobs = await this.prisma.automationJob.findMany({ where: { enabled: true, scheduleType: 'interval' } })
    } catch (err) {
      this.logger.error(`[automation] tick 查询 job 失败: ${errMessage(err)}`)
      return
    }
    for (const job of jobs) {
      try {
        if (!(await this.isDue(job, nowMs))) continue
        await this.dispatch(job, 'scheduled')
      } catch (err) {
        this.logger.error(`[automation] job ${job.id} 派发异常: ${errMessage(err)}`)
      }
    }
  }

  /** due 判据（D7）：最近一条 run（任意 status）的 startedAt + 间隔 ≤ now；无 run ⇒ due。 */
  private async isDue(job: AutomationJobRow, nowMs: number): Promise<boolean> {
    const last = await this.prisma.automationRun.findFirst({
      where: { jobId: job.id },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    if (!last) return true
    const intervalMs = Math.max(1, job.intervalMinutes) * 60_000
    return nowMs >= last.startedAt.getTime() + intervalMs
  }

  /**
   * 手动触发（admin）：与定时触发共用并发闸与 run 记录，reason='manual'。
   * 入参传完整 job 行（controller 已校验存在且 enabled）。
   */
  async triggerManual(job: AutomationJobRow): Promise<TriggerResult> {
    return this.dispatch(job, 'manual')
  }

  /**
   * 派发：forbid/replace 且已有在跑 → skipped 行（D6）；否则同步占位（D8）→
   * 建 running 行 → fire-and-forget 执行。
   */
  private async dispatch(job: AutomationJobRow, reason: AutomationRunReason): Promise<TriggerResult> {
    if (this.running.has(job.id) && job.concurrencyPolicy !== 'allow') {
      await this.prisma.automationRun.create({
        data: {
          jobId: job.id,
          reason,
          status: 'skipped',
          startedAt: new Date(this.nowFn()),
          finishedAt: new Date(this.nowFn()),
        },
      })
      this.logger.warn(`[automation] job ${job.id}（${reason}）上一轮仍在跑，本轮 skipped`)
      return { skipped: true }
    }
    this.running.set(job.id, 'pending')
    let runId: string
    try {
      const run = await this.prisma.automationRun.create({
        data: { jobId: job.id, reason, status: 'running', startedAt: new Date(this.nowFn()) },
      })
      runId = run.id
      this.running.set(job.id, runId)
    } catch (err) {
      this.running.delete(job.id)
      throw err
    }
    void this.execute(job, runId, reason)
    return { runId }
  }

  /** 执行 + 终态回写。handler 缺失/抛异常都折叠为 failure 行；落库失败只记日志（失败隔离）。 */
  private async execute(job: AutomationJobRow, runId: string, reason: AutomationRunReason): Promise<void> {
    let status: 'success' | 'failure' = 'success'
    let output: string | null = null
    let error: string | null = null
    try {
      const handler = this.handlers.get(job.handlerKey)
      if (!handler) throw new Error(`no handler registered for '${job.handlerKey}'`)
      let params: Record<string, unknown> = {}
      if (job.params) {
        try {
          const parsed = JSON.parse(job.params) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) params = parsed as Record<string, unknown>
        } catch {
          params = {}
        }
      }
      const result = await handler(params, { runId, reason })
      output = result === undefined ? null : JSON.stringify(result)
    } catch (err) {
      status = 'failure'
      error = errMessage(err)
      this.logger.error(`[automation] job ${job.id}（${reason}）执行失败: ${error}`)
    }
    try {
      await this.prisma.automationRun.update({
        where: { id: runId },
        data: { status, finishedAt: new Date(this.nowFn()), output, error },
      })
    } catch (err) {
      this.logger.error(`[automation] run ${runId} 终态回写失败: ${errMessage(err)}`)
    }
    if (this.running.get(job.id) === runId) this.running.delete(job.id)
  }
}
