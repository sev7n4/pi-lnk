import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { PointsService } from '../points/points.service'
import {
  alreadyRefunded,
  applyRefundMeta,
  isCancelledMeta,
} from '../points/charge-session'
import { studioPointCategory } from '../points/point-categories'
import { refundMeta } from '../points/point-tx.types'

/**
 * 回收范围（全部为走 `completeImage` 家族 detached 结算的图片侧记录）。
 *
 * 2026-10-08 二轮：原只收 `image`，生产巡检发现同类孤儿还散在
 * `image_edit`（2 条，2026-09-25/26）与 `image_upscale`（1 条，2026-09-20，
 * 该 type 在当前代码中已不再产生，属历史遗留），三者共 3 条已扣未退 30 分。
 * 成因与 image 完全相同（detached completion + 无 reaper），故一并纳入。
 *
 * ⛔ 不含 video/audio：video 有独立编排层（`VIDEO_POLL_TIMEOUT_MS = 21min`），
 * 且其 BYOK 退款语义（`byok_refund` + `fallback_pending` 分支）需单独评审后
 * 再决定是否纳入，避免误退/重复退。
 */
const REAP_TYPES = ['image', 'image_edit', 'image_upscale'] as const

/** 退款文案前缀，与各路径 `chargeReason` 保持一致（见 studio.service.ts）。 */
const REAP_REASON_BY_TYPE: Record<string, string> = {
  image: '图像生成',
  image_edit: '图像精修',
  image_upscale: '图像放大',
}

/** 卡死判定阈值：超过该分钟数仍停在 generating 的图片记录视为孤儿。 */
const DEFAULT_REAP_MINUTES = 30
/** 巡检间隔。 */
const REAP_INTERVAL_MS = 5 * 60 * 1000
/** 启动后首扫延迟：等应用就绪，专门回收上一进程（重启/崩溃）留下的孤儿。 */
const STARTUP_SWEEP_DELAY_MS = 15_000
/** 单轮最多回收条数：控制事务批量，剩余交给下一轮。 */
const REAP_BATCH = 50

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface StuckRecord {
  id: string
  type: string
  userId: string
  model: string | null
  metadata: string | null
}

/**
 * 图片生成收尾机制（reaper）。
 *
 * 背景（2026-10-08 诊断 B1/D2）：`generateImage` 的 `completeImage` 是 detached
 * 任务（`void completion`），进程重启/崩溃即永久丢失，记录卡在 `status='generating'`
 * 且已扣未退——生产实测 13 笔（最老 2026-08-01，最新当日），全仓无 @Cron。
 *
 * 本服务两道兜底：
 * 1. 启动后 15s 首扫——回收上一进程留下的孤儿；
 * 2. 每 5min 周期巡检——回收超时未结算的记录（含「失败路径自身失败」的逃逸场景）。
 *
 * exactly-once 语义：状态迁移用 `updateMany({ where: { status: 'generating' } })`
 * 守卫并与退款放进同一事务——与 `completeImage` 的结算守卫同构，谁先把 status
 * 迁走谁负责收尾；若 completeImage 先结算（罕见竞态），本服务 count=0 直接跳过。
 */
@Injectable()
export class GenerationReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GenerationReaperService.name)
  private timer?: ReturnType<typeof setInterval>
  private startupTimer?: ReturnType<typeof setTimeout>

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PointsService) private readonly points: PointsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return
    this.startupTimer = setTimeout(() => void this.reapOnce('startup'), STARTUP_SWEEP_DELAY_MS)
    this.timer = setInterval(() => void this.reapOnce('periodic'), REAP_INTERVAL_MS)
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.timer) clearInterval(this.timer)
  }

  /** 单轮回收。返回成功收尾的记录数；供未来管理端点手动触发。 */
  async reapOnce(reason: 'startup' | 'periodic' | 'manual'): Promise<number> {
    const minutes = Number(process.env.LNKPI_GENERATION_REAP_MINUTES ?? DEFAULT_REAP_MINUTES)
    const threshold = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_REAP_MINUTES
    const cutoff = new Date(Date.now() - threshold * 60_000)
    let stuck: StuckRecord[] = []
    try {
      stuck = await this.prisma.generationRecord.findMany({
        where: { type: { in: [...REAP_TYPES] }, status: 'generating', createdAt: { lt: cutoff } },
        select: { id: true, type: true, userId: true, model: true, metadata: true },
        take: REAP_BATCH,
      })
    } catch (err) {
      this.logger.error(`[${reason}] 查询卡死记录失败: ${errMessage(err)}`)
      return 0
    }
    let reaped = 0
    for (const rec of stuck) {
      try {
        reaped += await this.reapOne(rec)
      } catch (err) {
        this.logger.error(`[${reason}] 回收记录 ${rec.id} 失败: ${errMessage(err)}`)
      }
    }
    if (stuck.length > 0) {
      this.logger.warn(
        `[${reason}] 回收卡死图片侧生成 ${reaped}/${stuck.length} 条（类型 ${REAP_TYPES.join('/')}，阈值 ${threshold} 分钟，cutoff=${cutoff.toISOString()}）`,
      )
    } else if (reason === 'startup') {
      this.logger.log('[startup] 无卡死图片侧生成记录')
    }
    return reaped
  }

  /** 单条收尾：状态迁移 + 退款在同一事务，exactly-once。 */
  private async reapOne(rec: StuckRecord): Promise<0 | 1> {
    const meta = parseMeta(rec.metadata)
    const charged = typeof meta.chargedPoints === 'number' && meta.chargedPoints > 0 ? meta.chargedPoints : 0
    const needRefund = charged > 0 && !alreadyRefunded(meta) && !isCancelledMeta(meta)
    // 分类必须与扣费侧同源：image_upscale 扣在 other、image/image_edit 扣在 image，
    // 用同一个函数取，避免「退款分类 ≠ 扣费分类」的错账（见 point-categories.ts）。
    const category = studioPointCategory(rec.type)
    const reasonLabel = REAP_REASON_BY_TYPE[rec.type] ?? '生成'
    // BYOK 记录的失败退款在正常路径用 byok_refund（studio.service.ts completeImage），
    // 这里对齐同一语义；金额与 category 不受影响。
    const refundStatus = meta.providerSource === 'user' ? 'byok_refund' : 'failed_refund'
    const baseMeta: Record<string, unknown> = {
      ...meta,
      errorCode: 'upstream_timeout',
      userMessage: needRefund ? '生成超时，积分已退回' : '生成超时',
      failedAt: new Date().toISOString(),
      reapReason: 'stale_generating',
    }
    const finalMeta = needRefund
      ? applyRefundMeta(baseMeta, charged, '超时回收退款')
      : baseMeta
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.generationRecord.updateMany({
        where: { id: rec.id, status: 'generating' },
        data: { status: 'failed', metadata: JSON.stringify(finalMeta) },
      })
      if (updated.count === 0) return 0 as const
      if (needRefund) {
        await this.points.refundInTx(tx, rec.userId, charged, `${reasonLabel}-超时回收退款`, {
          ...refundMeta(category, refundStatus, {
            model: rec.model,
            generationId: rec.id,
          }),
        })
      }
      return 1 as const
    })
  }
}
