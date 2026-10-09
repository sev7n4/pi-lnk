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
 * 回收范围（走 detached 结算的图片侧 + 视频侧 + 文本侧记录）。
 *
 * 2026-10-08 二轮：原只收 `image`，生产巡检发现同类孤儿还散在
 * `image_edit`（2 条，2026-09-25/26）与 `image_upscale`（1 条，2026-09-20，
 * 该 type 在当前代码中已不再产生，属历史遗留），三者共 3 条已扣未退 30 分。
 * 成因与 image 完全相同（detached completion + 无 reaper），故一并纳入。
 *
 * 2026-10-08 三轮：纳入 `video`。视频 `completeVideo` 同为 detached
 * （`studio.service.ts` `.catch(console.error)`），进程重启即丢失，与图片
 * `completeImage` 同形态；生产另有 6 条 video 孤儿 / 290 分已扣未退。
 * 真实视频最坏耗时 ≈22.4min（MiniMax H3 轮询 deadline 20min + V6 创建重试
 * 上界 ~2.3min，见 {@link DEFAULT_VIDEO_REAP_MINUTES}），30min 阈值留 ~7.6min
 * 缓冲，不会误收正常生成中的记录。BYOK 退款语义（`byok_refund`）由 reapOne 的
 * `meta.providerSource === 'user'` 分支自动覆盖，与图片侧同路径。
 *
 * 2026-10-08 四轮：纳入 `text`。文本生成改 record-first 后（`studio.service.ts`
 * 先落 `status='generating'` 再调上游），进程崩溃/重启会留下永久孤儿。
 * 文本用**独立的 10min 阈值**（见 {@link DEFAULT_TEXT_REAP_MINUTES}）。
 *
 * ⚠️ 事实更正（供后人判读，勿据「纳入」推断「当前有活跃孤儿」）：
 * `image_edit` 与 `image_upscale` 在当前代码中**已不产生 `generating` 态**
 * （生产统计 completed 9 / failed 68，零 generating）⇒ reaper 对这两个 type
 * 是**历史遗留记录的清理**，不是对当前活跃作业的保护。它们留在 `REAP_TYPES`
 * 里只为清掉存量已扣未退的钱，不代表该type 还在产生新孤儿。
 *
 * ⛔ 不含 audio：audio 走同步执行链路（无 detached），无孤儿风险。
 *
 * ⛔ 不含 `prompt`（这是**正确的**，不是漏项，勿"补齐"）：`generatePrompt`
 * 的记录一律 `create` 成非`generating` 状态——`studio.service.ts:989/1019/1047`
 * 三处分别是 `completed` / `failed` / `fallback_pending`，**从不先落
 * `generating` 再等结算**，因此没有"卡在 generating"的孤儿形态可收。
 * `studioPointCategory('prompt')` 映射到 `'text'` 指的是**积分分类**，
 * 与本表的**回收范围**是两件事——前者共用，后者按"会不会产生 generating 态"划分。
 */
const REAP_TYPES = ['image', 'image_edit', 'image_upscale', 'video', 'text'] as const

/** 退款文案前缀，与各路径 `chargeReason` 保持一致（见 studio.service.ts）。 */
const REAP_REASON_BY_TYPE: Record<string, string> = {
  image: '图像生成',
  image_edit: '图像精修',
  image_upscale: '图像放大',
  video: '视频生成',
  text: '文本生成',
}

/** 卡死判定阈值：超过该分钟数仍停在 generating 的图片记录视为孤儿。 */
const DEFAULT_REAP_MINUTES = 30
/**
 * 视频侧独立阈值（分钟）。
 *
 * ⚠️ 必须与图片侧解耦：真实视频最坏耗时 ≈ 22.4min = MiniMax H3 轮询 deadline
 * `DEFAULT_MAX_POLL_MS = 1_200_000`（20min，见 minimax-h3-video-provider.ts，
 * 全 provider 最大 deadline）+ V6 创建重试上界 139.5s（3×45s + 退避 4.5s，
 * 病理上界；典型 429/503 只多 ~4.5s）。30min 默认留 ~7.6min 缓冲。
 *
 * 历史教训：video 原与 image 共用 `LNKPI_GENERATION_REAP_MINUTES`——为图片把
 * 该 env 调低，会把**正在生成中的视频**判成孤儿并退款；视频随后完成 ⇒
 * 「用户拿到视频 + 拿到退款」＝漏扣费（completeVideo 的状态守卫会把迟到的
 * 成功结果丢弃）。独立 env 后图片调优不再波及视频。
 *
 * 注：旧注释里的「视频超时 `VIDEO_POLL_TIMEOUT_MS = 21min`」是**虚构常量**
 * （代码里不存在），2026-10-09 已按真实 provider 源码更正为上式。
 * Agnes 是循环制（`maxPollAttempts=120`）无固定 deadline，异常态最坏 ≈70min，
 * 但那要求所有轮询都挂满 30s 超时——此时视频必然取不到 URL，提前回收退款
 * 对用户是更优结果（exactly-once 守卫保证不会与 completeVideo 双重结算）。
 */
const DEFAULT_VIDEO_REAP_MINUTES = 30
/**
 * 文本侧独立阈值（分钟）。
 *
 * 文本生成是秒级的：正常请求几秒内就落 `completed`/`failed`。卡 10 分钟仍然
 * 停在 `generating`，只可能是进程崩溃/重启留下的残留。共用图片的 30min 会让
 * 文本孤儿多存活 20 分钟——而这段时间里用户的积分已被扣走且无人退款。
 */
const DEFAULT_TEXT_REAP_MINUTES = 10
/** 巡检间隔。 */
const REAP_INTERVAL_MS = 5 * 60 * 1000
/** 启动后首扫延迟：等应用就绪，专门回收上一进程（重启/崩溃）留下的孤儿。 */
const STARTUP_SWEEP_DELAY_MS = 15_000
/** 单轮最多回收条数：控制事务批量，剩余交给下一轮。 */
const REAP_BATCH = 50

/** 解析分钟数env；缺失/非法/非正数时回落到默认值。 */
function positiveMinutes(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

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
 * 图片/视频/文本生成收尾机制（reaper）。
 *
 * 背景（2026-10-08 诊断 B1/D2）：`generateImage` 的 `completeImage` 是 detached
 * 任务（`void completion`），进程重启/崩溃即永久丢失，记录卡在 `status='generating'`
 * 且已扣未退——生产实测 13 笔（最老 2026-08-01，最新当日），全仓无 @Cron。
 *
 * 本服务两道兜底：
 * 1. 启动后 15s 首扫——回收上一进程留下的孤儿；
 * 2. 每 5min 周期巡检——回收超时未结算的记录（含「失败路径自身失败」的逃逸场景）。
 *
 * 阈值按 type 分派（图片 {@link DEFAULT_REAP_MINUTES} / 视频
 * {@link DEFAULT_VIDEO_REAP_MINUTES} / 文本 {@link DEFAULT_TEXT_REAP_MINUTES}），
 * 见 {@link reapOnce}。
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
    // 阈值按 type 分派：图片侧 30min、视频侧 30min（独立 env，见
    // DEFAULT_VIDEO_REAP_MINUTES）、文本侧 10min（秒级完成的作业卡
    // 10 分钟必然是崩溃残留，共用 30min 会让文本孤儿多存活 20 分钟）。
    // 分派方式用**三次 findMany**而非统一取min()：语义更清晰，且能保证
    // 「各组用各自阈值」这件事在代码里是显式的、可被测试断言的。
    const mediaMinutes = positiveMinutes(
      process.env.LNKPI_GENERATION_REAP_MINUTES,
      DEFAULT_REAP_MINUTES,
    )
    const videoMinutes = positiveMinutes(
      process.env.LNKPI_VIDEO_REAP_MINUTES,
      DEFAULT_VIDEO_REAP_MINUTES,
    )
    const textMinutes = positiveMinutes(process.env.LNKPI_TEXT_REAP_MINUTES, DEFAULT_TEXT_REAP_MINUTES)
    const groups: Array<{ types: readonly string[]; cutoff: Date }> = [
      {
        types: REAP_TYPES.filter((t) => t !== 'video' && t !== 'text'),
        cutoff: new Date(Date.now() - mediaMinutes * 60_000),
      },
      { types: ['video'], cutoff: new Date(Date.now() - videoMinutes * 60_000) },
      { types: ['text'], cutoff: new Date(Date.now() - textMinutes * 60_000) },
    ]

    let stuck: StuckRecord[] = []
    let queryFailed = false
    for (const group of groups) {
      try {
        const found = await this.prisma.generationRecord.findMany({
          where: { type: { in: [...group.types] }, status: 'generating', createdAt: { lt: group.cutoff } },
          select: { id: true, type: true, userId: true, model: true, metadata: true },
          take: REAP_BATCH,
        })
        stuck.push(...(found as StuckRecord[]))
      } catch (err) {
        queryFailed = true
        this.logger.error(
          `[${reason}] 查询卡死记录失败（类型 ${group.types.join('/')}）: ${errMessage(err)}`,
        )
      }
    }
    if (queryFailed && stuck.length === 0) return 0

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
        `[${reason}] 回收卡死图片/视频/文本侧生成 ${reaped}/${stuck.length} 条（类型 ${REAP_TYPES.join('/')}，阈值 图片 ${mediaMinutes} / 视频 ${videoMinutes} / 文本 ${textMinutes} 分钟）`,
      )
    } else if (reason === 'startup') {
      this.logger.log('[startup] 无卡死图片/视频/文本侧生成记录')
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
    // 退款文案优先用记录自带的 chargeReason：同属 type='image' 的还有「图像变体」
    // （generateImageVariation）这类子路径，只按 type 映射会把「图像变体」的退款
    // 写成「图像生成」（金额与 category 不受影响，仅文案）。
    const reasonLabel =
      (typeof meta.chargeReason === 'string' && meta.chargeReason) ||
      REAP_REASON_BY_TYPE[rec.type] ||
      '生成'
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
