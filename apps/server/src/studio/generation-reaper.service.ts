import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { DEFAULT_VIDEO_REAP_MINUTES as SHARED_VIDEO_REAP_MINUTES } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { CanvasNodeStatusService } from '../sessions/sessions-canvas-node-status.service'
import { PointsService } from '../points/points.service'
import { AutomationSchedulerService } from '../automation/automation-scheduler.service'
import {
  alreadyRefunded,
  applyRefundMeta,
  isCancelledMeta,
} from '../points/charge-session'
import { studioPointCategory } from '../points/point-categories'
import { refundMeta } from '../points/point-tx.types'
import { PiRuntimeClient } from '../agent/pi-runtime/pi-runtime.client'
import {
  notifyLateGenerationTerminals,
  piLateNotifyEnabled,
  type LateNotifyPrisma,
} from '../agent/pi-runtime/late-generation-notify'

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
 * 2026-11-03 五轮：纳入 `audio`（P0 配套，蓝老虎事故排查发现）。头注释旧断言
 * 「audio 走同步执行链路（无 detached），无孤儿风险」**已过时**：① music 的
 * `completeMusic` 是 detached（`studio.service.ts` submit + 轮询，官方 1–3min、
 * deadline 5min），进程重启即丢，生产实测恰有 2 条 music `generating` 孤儿
 * （2026-10-10/13，已扣未退）；② P1-B job 化后 `runAudioGeneration` 经
 * `start-*-generation` detached 执行；③ P0-b 记录先行后 design 分支也先落
 * `generating` 占位。阈值取图片同款 30min：music 正常最坏 5min + design 120s
 * 上界 + voice 45s，余量充足。BYOK 退款语义由 reapOne 既有分支自动覆盖。
 *
 * ⛔ 不含 `prompt`（这是**正确的**，不是漏项，勿"补齐"）：`generatePrompt`
 * 的记录一律 `create` 成非`generating` 状态——`studio.service.ts:989/1019/1047`
 * 三处分别是 `completed` / `failed` / `fallback_pending`，**从不先落
 * `generating` 再等结算**，因此没有"卡在 generating"的孤儿形态可收。
 * `studioPointCategory('prompt')` 映射到 `'text'` 指的是**积分分类**，
 * 与本表的**回收范围**是两件事——前者共用，后者按"会不会产生 generating 态"划分。
 */
const REAP_TYPES = ['image', 'image_edit', 'image_upscale', 'video', 'text', 'audio'] as const

/** 退款文案前缀，与各路径 `chargeReason` 保持一致（见 studio.service.ts）。 */
const REAP_REASON_BY_TYPE: Record<string, string> = {
  image: '图像生成',
  image_edit: '图像精修',
  image_upscale: '图像放大',
  video: '视频生成',
  text: '文本生成',
  audio: '音频生成',
}

/** 卡死判定阈值：超过该分钟数仍停在 generating 的图片记录视为孤儿。 */
const DEFAULT_REAP_MINUTES = 30
/**
 * 视频侧独立阈值（分钟）。
 *
 * 2026-10-09 起数值由 `@lnkpi/shared/generationTimeoutBudget` 提供（跨层
 * 超时预算单一来源）：web 墙钟 / agent 创建重试与轮询 deadline / 本阈值
 * 三层都从同一组常量派生，关系由不等式锁测试钉死。
 *
 * ⚠️ 必须与图片侧解耦：真实视频最坏耗时 `VIDEO_SERVER_WORST_MS` ≈ 22.3min
 * （MiniMax H3 轮询 deadline 20min + V6 创建重试上界 139.5s，病理上界；
 * 典型 429/503 只多 ~4.5s）。30min 默认留 ~7.7min 缓冲。
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
const DEFAULT_VIDEO_REAP_MINUTES = SHARED_VIDEO_REAP_MINUTES
/**
 * 文本侧独立阈值（分钟）。
 *
 * 文本生成是秒级的：正常请求几秒内就落 `completed`/`failed`。卡 10 分钟仍然
 * 停在 `generating`，只可能是进程崩溃/重启留下的残留。共用图片的 30min 会让
 * 文本孤儿多存活 20 分钟——而这段时间里用户的积分已被扣走且无人退款。
 */
const DEFAULT_TEXT_REAP_MINUTES = 10
/** 单轮最多回收条数：控制事务批量，剩余交给下一轮。 */
const REAP_BATCH = 50

/**
 * P0-d（2026-11-03 蓝老虎生产事故）：无生成记录的孤儿 generating 节点判定阈值。
 *
 * 形态：节点 `status:'generating'` 但 `generationRecordId` 缺失——detached 管线在
 * 「persist(started) 之后、record 创建之前」挂死/崩溃留下（audio design/voice 分支
 * 旧行为；修复后仍可能因进程崩溃出现）。B2 对账只扫「有记录」的终态回推，
 * 对这类节点是盲区（生产实证：蓝老虎两节点卡 8h+ 无人修复，取消恒 404）。
 * 30min 与图片记录回收阈值同源：有界超时修复后，正常管线最坏也在分钟级落终态。
 */
const ORPHAN_NODE_STUCK_MINUTES = 30
/** 孤儿节点扫描的会话回看窗：孤儿会话的最后写入时刻 = 孤儿产生时刻。 */
const ORPHAN_NODE_SCAN_WINDOW_MINUTES = 24 * 60
/** 单轮最多处理的会话数（画布 JSON 解析开销护栏，剩余交给下一轮）。 */
const ORPHAN_NODE_SCAN_BATCH = 500

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
/**
 * C5 起定时职责移交 AutomationSchedulerService，本服务不再持有 timer：
 * onModuleInit 只注册 handler（'generation-reaper'）；15s 启动首扫与 5min 巡检
 * 由 AutomationJob（runOnStartup + intervalMinutes=5）承载。
 */
@Injectable()
export class GenerationReaperService implements OnModuleInit {
  private readonly logger = new Logger(GenerationReaperService.name)

  /**
   * 回合外投影记账者钩子（2026-11-02 天鹅事故 P0-A）。
   *
   * 由 AgentService onModuleInit 注册（AgentService 经 @Optional 注入本服务——
   * AgentModule imports StudioModule，方向安全、零环；缺省 = 未装配 = 只通报不投影，
   * 行为与今天一致）。签名 = pi-runtime 的**原始 threadKey**（AgentThread.id）。
   */
  outOfTurnProjectionHook?: (threadId: string) => Promise<void> | void

  /**
   * 投影订阅**预挂**钩子（2026-11-03 蓝老虎复测 Layer 3：订阅时序竞态）。
   *
   * notify-generation 到达 runtime 的瞬间，handler 内同步 drain 开简报轮——
   * 后置的 onDelivered 订阅必然错过 agent_start（from=now 语义）。
   * 本钩子在 notify **之前**被 await：AgentService 挂事件订阅并等 SSE open，
   * 使简报轮 agent_start 落在订阅窗口内。缺省 = 退化为旧行为（通报照发）。
   */
  outOfTurnArmHook?: (threadId: string) => Promise<void> | void

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PointsService) private readonly points: PointsService,
    // B2：可选注入——单测直接构造时无该服务，对账扫描跳过（对账绝不影响回收主链）。
    @Optional() @Inject(CanvasNodeStatusService) private readonly nodeStatus?: CanvasNodeStatusService,
    // C5：可选注入——单测直接构造时无 scheduler，跳过 handler 注册。
    @Optional() @Inject(AutomationSchedulerService) private readonly scheduler?: AutomationSchedulerService,
  ) {}

  onModuleInit(): void {
    // C5：15s 启动首扫 + 5min 巡检移交 AutomationSchedulerService（runOnStartup +
    // interval=5，见 AUTOMATION_DEFAULT_JOBS；D2/D4）。reason 映射：scheduled→periodic。
    if (!this.scheduler) return
    this.scheduler.registerHandler('generation-reaper', async (_params, ctx) => {
      return this.reapOnce(ctx.reason === 'scheduled' ? 'periodic' : ctx.reason)
    })
    // 终态通报快节拍（2026-11-03 黄小龙虾复测：图片终态写点在 studio 管线，不走
    // agent-canvas-tools 结算点直发 ⇒ 只能等 reaper 5min 兜底，简报延迟 0~6min 随机）。
    // 1min 快巡检只跑通报扫描（单一 findMany + durable 去重），单飞守卫与 reaper
    // 巡检互斥——简报延迟从最长 6min 压到 ≤1min，零新增写点挂钩。
    this.scheduler.registerHandler('generation-notify', async (_params, ctx) => {
      await this.notifyTerminalsOnce(ctx.reason === 'scheduled' ? 'notify-tick' : ctx.reason)
      return 0
    })
    this.logger.log('[reaper] 回收 handler 已注册至 AutomationSchedulerService（配置见 AutomationJob）')
  }

  /** 单轮回收。返回成功收尾的记录数；供未来管理端点手动触发。 */
  async reapOnce(reason: 'startup' | 'periodic' | 'manual'): Promise<number> {
    // 阈值按 type 分派：图片/audio 侧 30min、视频侧 30min（独立 env，见
    // DEFAULT_VIDEO_REAP_MINUTES）、文本侧 10min（秒级完成的作业卡
    // 10 分钟必然是崩溃残留，共用 30min 会让文本孤儿多存活 20 分钟）。
    // 分派方式用**三次 findMany**而非统一取min()：语义更清晰，且能保证
    // 「各组用各自阈值」这件事在代码里是显式的、可被测试断言的。
    // （audio 2026-11-03 纳入媒体组：music 正常最坏 5min / design 120s / voice 45s，
    // 30min 阈值余量充足，见 REAP_TYPES 头注释「五轮」。）
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

    // 回合外生成终态通报（2026-10-18 上游对齐，Nest→lane followUp）：
    // 扫「最近落终态 + 有画布会话 + 未通报」的记录 → pi-runtime notify-generation
    // （工具仍在等 ⇒ 抑制；否则入 lane followUp，模型主动向用户简报）。
    // 通报失败/未启用不影响回收主链路（fail-soft，下一轮巡检重试）。
    await this.notifyTerminalsOnce(reason)
    // B2 画布节点终态对账（RCA v2 §4-B2）：与通报独立（通报可能被「工具仍在等」抑制，
    // 节点状态修复不能跟着被抑制）。fail-soft。
    try {
      const fixed = await this.reconcileAgentNodeStatuses(reason)
      if (fixed > 0) {
        this.logger.log(`[${reason}] 画布节点终态对账已修复 ${fixed} 个`)
      }
    } catch (err) {
      this.logger.warn(`[${reason}] 画布节点终态对账失败（不影响回收）: ${errMessage(err)}`)
    }
    // P0-d 无记录孤儿 generating 节点兜底（2026-11-03 蓝老虎生产事故）：B2 对账
    // 只覆盖「有记录」的节点；detached 管线在建记录前挂死留下的孤儿节点是盲区。
    // fail-soft 同上。
    try {
      const fixed = await this.reconcileOrphanGeneratingNodes(reason)
      if (fixed > 0) {
        this.logger.warn(`[${reason}] 无记录孤儿 generating 节点已兜底置 error ${fixed} 个`)
      }
    } catch (err) {
      this.logger.warn(`[${reason}] 孤儿 generating 节点扫描失败（不影响回收）: ${errMessage(err)}`)
    }
    return reaped
  }

  /**
   * 单飞守卫：通报扫描（reaper 5min 巡检 + generation-notify 1min 快节拍）互斥。
   *
   * notifyLateGenerationTerminals 的 durable 去重（agentTurnNotified）保证「先后两次
   * 扫描」不重发，但**并发**两次扫描会在任一方 markNotified 前都读到未标记 ⇒ 双通报
   * ⇒ runtime 排两条简报轮。宁可跳过一轮（未处理记录下个 tick 重扫），不赌竞态。
   */
  private notifyInFlight = false

  /**
   * 回合外终态通报扫描（reapOnce 与 generation-notify 快节拍共用，2026-11-03 抽出）。
   * fail-soft：任何异常只 warn，绝不影响调用方主链路。
   */
  private async notifyTerminalsOnce(reason: string): Promise<void> {
    if (!piLateNotifyEnabled()) return
    if (this.notifyInFlight) return // 上一轮扫描还在跑：本轮跳过（单飞守卫，见上）
    this.notifyInFlight = true
    try {
      const client = new PiRuntimeClient({ baseUrl: process.env.PI_RUNTIME_URL!.trim() })
      // 结构子集注入：Prisma 泛型签名比窄接口宽，显式收窄（select 字段已在模块内对齐）
      const notified = await notifyLateGenerationTerminals(
        this.prisma as unknown as LateNotifyPrisma,
        client,
        this.logger,
        {
          // 回合外投影记账者（2026-11-02 天鹅事故 P0-A）：delivered 后由 AgentService
          // 挂短命订阅把简报轮落库（AgentMessage 是展示层 SSOT，不落库 = 刷新即失）。
          // 钩子由 AgentService onModuleInit 注册（AgentModule imports StudioModule，
          // 复用既有依赖方向，不新增模块/端口）；未注册 = 行为与今天逐字节一致。
          onDelivered: (threadId) => {
            try {
              const hook = this.outOfTurnProjectionHook
              if (hook) void hook(threadId)
            } catch (err) {
              this.logger.warn(`[late-notify] 投影记账者派发失败（不影响通报）: ${errMessage(err)}`)
            }
          },
          // 订阅先于触发（2026-11-03 Layer 3）：notify 前预挂投影订阅并等 SSE open，
          // 否则 runtime 同步 drain 开的简报轮 agent_start 必然早于订阅（from=now
          // 收不到）⇒ 因果围栏静默丢整轮（蓝老虎复测生产实证）。await 由
          // notifyLateGenerationTerminals 负责（fail-open，arm 抛错不阻塞通报）。
          onBeforeNotify: (threadId) => {
            const hook = this.outOfTurnArmHook
            if (!hook) return
            return Promise.resolve(hook(threadId)).catch(() => {
              /* fail-open：arm 失败在钩子内已 warn，这里不阻塞通报 */
            })
          },
        },
      )
      if (notified > 0) {
        this.logger.log(`[${reason}] 回合外生成终态通报已处理 ${notified} 条`)
      }
    } catch (err) {
      this.logger.warn(`[${reason}] 回合外终态通报扫描失败（不影响回收）: ${errMessage(err)}`)
    } finally {
      this.notifyInFlight = false
    }
  }

  /**
   * B2 终态对账（2026-11-02 老黄牛死循环护栏，RCA v2 §4-B2）：扫「最近落终态 + 挂在画布
   * 会话节点上」的记录，把仍处于 pre-terminal 的画布节点 status 推到记录终态。
   *
   * 为什么收敛在这里而不是每个结算点：studio 有 20+ 个 generationRecord 终态写点
   * （image/variation/video/audio/text/refine），逐点挂钩 diff 大且漏一个就复发；
   * 记录终态后 updatedAt 必然刷新 ⇒ 本扫描天然命中，节点推到终态后下轮不再命中
   * （按状态幂等，无需 dedup 标记）。image 主路径另有 generateImage 内直写（≤秒级），
   * 本扫描是全介质兜底（≤5min 巡检间隔）。fail-soft：绝不影响回收主链路。
   */
  private async reconcileAgentNodeStatuses(reason: string): Promise<number> {
    if (!this.nodeStatus) return 0 // 单测/降级：无写者即无对账
    const since = new Date(Date.now() - 15 * 60 * 1000)
    const rows = await this.prisma.generationRecord.findMany({
      where: {
        sessionId: { not: null },
        nodeId: { not: null },
        updatedAt: { gte: since },
        status: { in: ['completed', 'failed', 'error'] },
      },
      select: { id: true, sessionId: true, nodeId: true, status: true },
      take: 200,
    })
    let fixed = 0
    const TERMINAL = new Set(['completed', 'failed', 'error'] as const)
    for (const r of rows) {
      if (!r.sessionId || !r.nodeId) continue
      if (!(TERMINAL as ReadonlySet<string>).has(r.status)) continue
      try {
        const res = await this.nodeStatus.reconcileTerminal(
          r.sessionId,
          r.nodeId,
          r.status as 'completed' | 'failed' | 'error',
          r.id,
        )
        if (res === 'applied') fixed += 1
      } catch (err) {
        this.logger.warn(
          `[${reason}] 节点终态对账失败（fail-soft）record=${r.id} node=${r.nodeId}: ${errMessage(err)}`,
        )
      }
    }
    return fixed
  }

  /**
   * P0-d 无记录孤儿 generating 节点兜底（2026-11-03 蓝老虎生产事故）。
   *
   * 形态与 B2 对账互补：B2 扫「记录已终态、节点被卡」；本扫描兜的是「**根本没有
   * 记录**」——detached 管线在 persist(started) 之后、record 创建之前挂死/崩溃
   * （audio design/voice 旧行为的生产实证：节点 generating 8h+，取消 404，
   * reaper 全程失明）。判定 = 节点 `status:'generating'` + 无 `generationRecordId`
   * + `generationStartedAt` 早于阈值 ⇒ 就地置 `error`（迁移表 generating→error 合法，
   * 走 CanvasNodeStatusService.mergeNodeData 同一事务守卫）。
   *
   * 成本护栏：先用 `canvasData CONTAINS '"generating"'` 预筛（绝大多数会话无生成中
   * 节点，JSON 解析只发生在命中会话上）+ 24h 回看窗 + 单轮 500 会话上限。
   * 不退款：孤儿无记录无金额锚点（扣分泄漏属 P0-b 记录先行的修复范围，存量手工）。
   * fail-soft：绝不影响回收主链路。
   */
  private async reconcileOrphanGeneratingNodes(reason: string): Promise<number> {
    if (!this.nodeStatus) return 0 // 单测/降级：无写者即无对账
    const since = new Date(Date.now() - ORPHAN_NODE_SCAN_WINDOW_MINUTES * 60 * 1000)
    const stuckBefore = new Date(Date.now() - ORPHAN_NODE_STUCK_MINUTES * 60 * 1000)
    const sessions = await this.prisma.session.findMany({
      where: {
        updatedAt: { gte: since },
        // JSON 文本预筛：只解析画布里真的存在 generating 字样的会话
        canvasData: { contains: '"generating"' },
      },
      select: { id: true, canvasData: true },
      orderBy: { updatedAt: 'desc' },
      take: ORPHAN_NODE_SCAN_BATCH,
    })
    let fixed = 0
    for (const session of sessions) {
      let canvas: { nodes?: Array<{ id?: unknown; data?: Record<string, unknown> }> }
      try {
        canvas = JSON.parse(session.canvasData ?? '{}') as typeof canvas
      } catch {
        continue
      }
      const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : []
      for (const node of nodes) {
        if (typeof node?.id !== 'string') continue
        const data = node.data
        if (!data || data.status !== 'generating') continue
        if (typeof data.generationRecordId === 'string' && data.generationRecordId) continue
        const startedAtMs = Date.parse(String(data.generationStartedAt ?? ''))
        // 无 generationStartedAt（更早的历史残留）保守跳过——没有时刻证据就不判死
        if (!Number.isFinite(startedAtMs)) continue
        if (startedAtMs > stuckBefore.getTime()) continue
        try {
          const res = await this.nodeStatus.mergeNodeData(session.id, node.id, {
            status: 'error',
            errorMessage: '生成超时（未留下生成记录，疑似服务中断），请重试',
          })
          if (res === 'applied') {
            fixed += 1
            this.logger.warn(
              `[${reason}] 孤儿 generating 节点置 error（无记录，startedAt=${new Date(startedAtMs).toISOString()}）session=${session.id} node=${node.id}`,
            )
          }
        } catch (err) {
          this.logger.warn(
            `[${reason}] 孤儿 generating 节点修复失败（fail-soft）session=${session.id} node=${node.id}: ${errMessage(err)}`,
          )
        }
      }
    }
    return fixed
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
