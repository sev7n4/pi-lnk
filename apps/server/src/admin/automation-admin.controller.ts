import { Controller, Get, Inject, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AdminTokenGuard } from './admin-token.guard'
import { AutomationSchedulerService, type AutomationJobRow } from '../automation/automation-scheduler.service'

function parseJsonOrNull(raw: string | null | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * C5 P0 admin 端点（spec §4.4 的只读 + trigger 子集；PATCH 改配置属 P1）。
 * 全部 AdminTokenGuard（§6-6），响应形状 { code: 0, message: 'ok', data }。
 */
@Controller('admin/automations')
export class AutomationAdminController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AutomationSchedulerService) private readonly scheduler: AutomationSchedulerService,
  ) {}

  /** job 列表 + 每个 job 最近一条 run 摘要（G4 只读）。 */
  @Get()
  @UseGuards(AdminTokenGuard)
  async list() {
    const jobs = await this.prisma.automationJob.findMany({ orderBy: { id: 'asc' } })
    const data = await Promise.all(
      jobs.map(async (job) => {
        const lastRun = await this.prisma.automationRun.findFirst({
          where: { jobId: job.id },
          orderBy: { startedAt: 'desc' },
        })
        return {
          id: job.id,
          name: job.name,
          description: job.description,
          handlerKey: job.handlerKey,
          enabled: job.enabled,
          scheduleType: job.scheduleType,
          intervalMinutes: job.intervalMinutes,
          params: parseJsonOrNull(job.params),
          concurrencyPolicy: job.concurrencyPolicy,
          runOnStartup: job.runOnStartup,
          updatedAt: job.updatedAt,
          lastRun: lastRun && {
            id: lastRun.id,
            reason: lastRun.reason,
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            error: lastRun.error,
          },
        }
      }),
    )
    return { code: 0, message: 'ok', data: { jobs: data } }
  }

  /** 运行史分页（G2）：startedAt 倒序，默认 1/20，pageSize 上限 100。 */
  @Get(':id/runs')
  @UseGuards(AdminTokenGuard)
  async runs(@Param('id') id: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const job = await this.prisma.automationJob.findUnique({ where: { id } })
    if (!job) throw new NotFoundException('automation job not found')
    const p = Math.max(1, Number(page) || 1)
    const size = Math.min(100, Math.max(1, Number(pageSize) || 20))
    const [total, runs] = await this.prisma.$transaction([
      this.prisma.automationRun.count({ where: { jobId: id } }),
      this.prisma.automationRun.findMany({
        where: { jobId: id },
        orderBy: { startedAt: 'desc' },
        skip: (p - 1) * size,
        take: size,
      }),
    ])
    return {
      code: 0,
      message: 'ok',
      data: {
        total,
        page: p,
        pageSize: size,
        runs: runs.map((r) => ({
          id: r.id,
          reason: r.reason,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          output: parseJsonOrNull(r.output),
          error: r.error,
        })),
      },
    }
  }

  /** 手动触发（G4）：与定时共用并发闸；disabled/未知 → 404。 */
  @Post(':id/trigger')
  @UseGuards(AdminTokenGuard)
  async trigger(@Param('id') id: string) {
    const job = await this.prisma.automationJob.findUnique({ where: { id } })
    if (!job || !job.enabled) throw new NotFoundException('automation job not found or disabled')
    const result = await this.scheduler.triggerManual(job as AutomationJobRow)
    return { code: 0, message: 'ok', data: result }
  }
}
