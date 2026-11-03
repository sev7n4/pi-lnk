import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { DEFAULT_VIDEO_REAP_MINUTES, VIDEO_SERVER_WORST_MS } from '@lnkpi/shared'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { CanvasNodeStatusService } from '../sessions/sessions-canvas-node-status.service'
import { AutomationSchedulerService } from '../automation/automation-scheduler.service'
import { GenerationReaperService } from './generation-reaper.service'
import { TerminalEventBus } from './terminal-events'
import { notifyMetrics } from './notify-metrics'

// 通报扫描 mock（file 级）：快节拍/单飞守卫用例需要可控的扫描桩。
// piLateNotifyEnabled 保留真实现（env 驱动）⇒ 既有用例不设 PI_RUNTIME_URL 时
// 通报路径天然关闭，行为不变。
const notifyScanMock = vi.hoisted(() => vi.fn(async () => 0))
vi.mock('../agent/pi-runtime/late-generation-notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/pi-runtime/late-generation-notify')>()
  return {
    ...actual,
    notifyLateGenerationTerminals: notifyScanMock,
  }
})

function makeMeta(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ chargedPoints: 10, ...extra })
}

interface StoredRecord {
  id: string
  type: string
  userId: string
  model: string | null
  metadata: string | null
  status: string
  createdAt: Date
}

describe('GenerationReaperService 收尾机制', () => {
  let svc: GenerationReaperService
  let generationFindMany: ReturnType<typeof vi.fn>
  let generationUpdateMany: ReturnType<typeof vi.fn>
  let refundInTx: ReturnType<typeof vi.fn>
  let tx: Record<string, unknown>

  /**
   * 假库。`findMany` 必须**真的按 where 过滤**（type in / status / createdAt.lt），
   * 否则「从 REAP_TYPES 删掉 text」这类变异杀不掉测试——桩把记录无条件返回，
   * 变异后测试照样绿（Task 3 的假绿教训）。
   */
  let db: StoredRecord[]
  /** 模拟 completeImage 在 findMany 之后、updateMany 之前抢先结算（竞态）。 */
  let raceComplete: boolean

  const env = { ...process.env }

  /**
   * 造一条记录（默认：1 小时前创建的 `generating` 记录）。
   *
   * ⚠️ `...partial` 必须放在**默认值之前**：否则将来有人写
   * `seed({ id:'x', createdAt: undefined })` 会把默认时间覆盖成 `undefined`，
   * 让 `r.createdAt < cutoff` 恒为 false，用例变成假绿（却看不出为什么）。
   * 显式 `undefined` 由后面的 `??` 兜回默认值。
   */
  function seed(partial: Partial<StoredRecord> & { type: string }): void {
    db.push({
      ...partial,
      id: partial.id ?? `rec-${db.length + 1}`,
      userId: partial.userId ?? 'u1',
      model: partial.model ?? null,
      metadata: partial.metadata ?? makeMeta(),
      status: partial.status ?? 'generating',
      createdAt: partial.createdAt ?? new Date(Date.now() - 60 * 60_000),
    })
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env = { ...env }
    delete process.env.LNKPI_GENERATION_REAP_MINUTES
    delete process.env.LNKPI_VIDEO_REAP_MINUTES
    delete process.env.LNKPI_TEXT_REAP_MINUTES
    db = []
    raceComplete = false

    generationFindMany = vi.fn(
      async (args: {
        where: { type: { in: string[] }; status?: string; createdAt: { lt: Date } }
        select: Record<string, boolean>
        take: number
      }) => {
        const rows = db.filter(
          (r) =>
            args.where.type.in.includes(r.type) &&
            // 同updateMany 桩：`status` 缺失 = 不带该条件（Prisma 语义），
            // 不是「匹配不到」。写死比较会让「实现漏掉 status 过滤」这个变异
            // 表现为「一条都查不到」，掩盖掉它真正该造成的「重复退款」后果。
            (args.where.status === undefined || r.status === args.where.status) &&
            r.createdAt < args.where.createdAt.lt,
        )
        // 竞态注入：在记录已被 findMany 选中之后、updateMany 之前把它结算掉
        if (raceComplete) {
          for (const r of rows) r.status = 'completed'
        }
        return rows.slice(0, args.take).map(({ id, type, userId, model, metadata }) => ({
          id,
          type,
          userId,
          model,
          metadata,
        }))
      },
    )
    generationUpdateMany = vi.fn(
      async (args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
        const row = db.find((r) => r.id === args.where.id)
        if (!row) return { count: 0 }
        // ⚠️ 必须复刻 Prisma 语义：`where.status` **缺失时不是「匹配不到」，
        // 而是「不带该条件」**。早先写成 `row.status !== args.where.status` 时，
        // 任何省略 status 的 where 都会被判成 count=0 —— 于是「去掉状态守卫」
        // 这个变异连**第一次** reap 都返回 0，看起来是 14 条全红的「强变异」，
        // 实际是我的桩不忠实，掩盖了它真正该打红的那条用例。
        if (args.where.status !== undefined && row.status !== args.where.status) return { count: 0 }
        row.status = String(args.data.status)
        row.metadata = String(args.data.metadata)
        return { count: 1 }
      },
    )
    refundInTx = vi.fn(async () => {})
    tx = {
      generationRecord: { updateMany: generationUpdateMany },
    }
    const prismaMock = {
      generationRecord: { findMany: generationFindMany },
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<number>) => fn(tx)),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        GenerationReaperService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: PointsService, useValue: { refundInTx } },
      ],
    }).compile()
    svc = moduleRef.get(GenerationReaperService)
  })

  afterEach(() => {
    process.env = env
  })

  it('卡死记录：标记 failed(upstream_timeout) + 同事务退款，退款带 generationId', async () => {
    seed({ id: 'r1', type: 'image', model: 'seedream-5.0-pro' })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    const data = generationUpdateMany.mock.calls[0][0].data
    expect(data.status).toBe('failed')
    const meta = JSON.parse(String(data.metadata))
    expect(meta.errorCode).toBe('upstream_timeout')
    expect(meta.refundedPoints).toBe(10)
    expect(meta.refundReason).toBe('超时回收退款')
    // 退款在事务内且 generationId 指向该记录
    const refundArgs = refundInTx.mock.calls[0]
    expect(refundArgs[1]).toBe('u1')
    expect(refundArgs[2]).toBe(10)
    expect(refundArgs[4].generationId).toBe('r1')
    expect(refundArgs[4].status).toBe('failed_refund')
  })

  it('已退款但状态卡死的记录：只补状态迁移，不重复退款', async () => {
    seed({
      id: 'r2',
      type: 'image',
      metadata: makeMeta({ refundedPoints: 10, refundReason: '平台失败退款' }),
    })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    expect(refundInTx).not.toHaveBeenCalled()
    const meta = JSON.parse(String(generationUpdateMany.mock.calls[0][0].data.metadata))
    expect(meta.refundedPoints).toBe(10) // 保留原退款标记
    expect(meta.errorCode).toBe('upstream_timeout')
  })

  it('用户已取消的记录：标记 failed 但不退款', async () => {
    seed({ id: 'r3', type: 'image', metadata: makeMeta({ cancelled: true }) })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    expect(refundInTx).not.toHaveBeenCalled()
  })

  it('无 chargedPoints 的记录：只迁移状态', async () => {
    seed({ id: 'r4', type: 'image', metadata: JSON.stringify({ foo: 1 }) })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    expect(refundInTx).not.toHaveBeenCalled()
    const meta = JSON.parse(String(generationUpdateMany.mock.calls[0][0].data.metadata))
    expect(meta.userMessage).toBe('生成超时')
  })

  it('状态守卫未命中（completeImage 已先行结算）：跳过且不退款', async () => {
    // 模拟 completeImage 恰好在 findMany 之后、updateMany 之前结算完成
    raceComplete = true
    seed({ id: 'r5', type: 'image' })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(0)
    expect(refundInTx).not.toHaveBeenCalled()
    expect(generationUpdateMany).toHaveBeenCalled()
  })

  /**
   * 字面场景：同一个用例里连跑两次 `reapOnce`。
   *
   * 这条同时锁住三件事，是唯一把它们串起来的用例：
   *   1. `findMany` 的 `status`过滤——第二次查不到这条记录（≠查到了才被挡掉）；
   *   2. `updateMany` 的 `status='generating'` 守卫——即便记录再次被选中也不迁移；
   *   3. 不重复退款——`refundInTx` 全程只调一次。
   *
   * 走真实假库路径（不覆盖 `updateMany` 桩），否则断言的是桩的行为而非实现的。
   *
   * ⚠️ 断言分两类，**两类都必要**：
   *   - 行为断言（`toHaveBeenCalledTimes` / `db` 里的 status / `refundInTx` 次数）
   *     才能抓住「findMany 漏掉 status 过滤」——那时第二次会真的迁移一次、
   *     `updateMany` 被调2 次。
   *   - 结构性断言（`where` 里带 `status: 'generating'`）才能抓住「updateMany
   *     漏掉状态守卫」——该变异下第二次仍被 findMany 挡住，行为看不出来，
   *     只有看where 才知道守卫没了。
   * 早期版本只有后者（探针实测：删掉两条结构性断言后，updateMany 去守卫的变异
   * 竟然全绿），等于没测。
   */
  it('exactly-once：连跑两次 reapOnce 只收尾一次，第二次既不迁移也不退款', async () => {
    seed({ id: 'r6', type: 'image', metadata: makeMeta() })

    const first = await svc.reapOnce('manual')

    expect(first).toBe(1)
    expect(generationUpdateMany).toHaveBeenCalledTimes(1)
    expect(generationUpdateMany.mock.calls[0][0].where).toMatchObject({ id: 'r6', status: 'generating' })
    expect(db.find((r) => r.id === 'r6')?.status).toBe('failed')
    expect(refundInTx).toHaveBeenCalledTimes(1)

    const second = await svc.reapOnce('manual')

    // 第二次：无迁移、无退款（少一条迁移 = 无条件迁移的守卫生效）
    expect(second).toBe(0)
    expect(generationUpdateMany).toHaveBeenCalledTimes(1)
    expect(refundInTx).toHaveBeenCalledTimes(1)
  })

  it('回收范围含视频侧、按阈值过滤 createdAt', async () => {
    await svc.reapOnce('manual')

    // 三次 findMany：图片+audio 媒体组一组、视频侧一组（V2b 独立阈值）、文本侧一组
    expect(generationFindMany).toHaveBeenCalledTimes(3)
    const imageWhere = generationFindMany.mock.calls[0][0].where
    // audio 2026-11-03 纳入媒体组（music completeMusic detached + P1-B job 化）
    expect(imageWhere.type).toEqual({ in: ['image', 'image_edit', 'image_upscale', 'audio'] })
    expect(imageWhere.status).toBe('generating')
    expect(imageWhere.createdAt.lt).toBeInstanceOf(Date)
    // 默认 30 分钟阈值（真实视频最坏 ≈22.4min = MiniMax H3 20min + V6 创建重试上界
    // ~2.3min，30min 留 ~7.6min 缓冲；旧注释的 VIDEO_POLL_TIMEOUT_MS=21min 是虚构常量）
    expect(Date.now() - imageWhere.createdAt.lt.getTime()).toBeGreaterThan(29 * 60_000)
    // 视频组独立成组，默认阈值同为 30min
    const videoWhere = generationFindMany.mock.calls[1][0].where
    expect(videoWhere.type).toEqual({ in: ['video'] })
    expect(Date.now() - videoWhere.createdAt.lt.getTime()).toBeGreaterThan(29 * 60_000)
  })

  it('image_edit 孤儿：退款分类 image + 文案「图像精修」', async () => {
    seed({ id: 'e1', type: 'image_edit', model: 'agnes-image-edit' })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    const refundArgs = refundInTx.mock.calls[0]
    expect(refundArgs[2]).toBe(10)
    expect(refundArgs[3]).toBe('图像精修-超时回收退款')
    expect(refundArgs[4].category).toBe('image')
    expect(refundArgs[4].generationId).toBe('e1')
  })

  it('image_upscale 孤儿：退款分类 other（与扣费侧同源，避免错账）', async () => {
    seed({ id: 'p1', type: 'image_upscale' })

    await svc.reapOnce('manual')

    expect(refundInTx.mock.calls[0][4].category).toBe('other')
    expect(refundInTx.mock.calls[0][3]).toBe('图像放大-超时回收退款')
  })

  it('图像变体孤儿：退款文案用记录自带的 chargeReason（不再是「图像生成」）', async () => {
    seed({
      id: 'v1',
      type: 'image',
      model: 'seedream-5.0-pro',
      metadata: makeMeta({ variation: true, chargeReason: '图像变体' }),
    })

    await svc.reapOnce('manual')

    expect(refundInTx.mock.calls[0][3]).toBe('图像变体-超时回收退款')
    // 分类仍与扣费侧同源（图像变体扣在 image）
    expect(refundInTx.mock.calls[0][4].category).toBe('image')
  })

  it('BYOK 孤儿：退款状态用 byok_refund（对齐正常失败路径语义）', async () => {
    seed({ id: 'b1', type: 'image', model: 'agnes-image', metadata: makeMeta({ providerSource: 'user' }) })

    await svc.reapOnce('manual')

    expect(refundInTx.mock.calls[0][4].status).toBe('byok_refund')
    expect(refundInTx.mock.calls[0][4].category).toBe('image')
  })

  it('video 孤儿：标记 failed + 退款带 generationId，分类 video，文案「视频生成」', async () => {
    seed({
      id: 'vid1',
      type: 'video',
      model: 'seedance-2.0-min',
      metadata: makeMeta({ chargeReason: '视频生成' }),
    })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    const data = generationUpdateMany.mock.calls[0][0].data
    expect(data.status).toBe('failed')
    const refundArgs = refundInTx.mock.calls[0]
    expect(refundArgs[1]).toBe('u1')
    expect(refundArgs[2]).toBe(10)
    expect(refundArgs[3]).toBe('视频生成-超时回收退款')
    expect(refundArgs[4].category).toBe('video')
    expect(refundArgs[4].generationId).toBe('vid1')
    expect(refundArgs[4].status).toBe('failed_refund')
  })

  it('video BYOK 孤儿：退款状态用 byok_refund（对齐正常失败路径语义）', async () => {
    seed({
      id: 'vidb',
      type: 'video',
      model: 'minimax-h3',
      metadata: makeMeta({ providerSource: 'user', chargeReason: '视频生成' }),
    })

    await svc.reapOnce('manual')

    expect(refundInTx.mock.calls[0][4].status).toBe('byok_refund')
    expect(refundInTx.mock.calls[0][4].category).toBe('video')
    expect(refundInTx.mock.calls[0][3]).toBe('视频生成-超时回收退款')
  })

  // ── V2b：video 与 image 的回收阈值解耦 ──
  // 真实视频最坏耗时 = MiniMax H3 轮询 deadline 20min（DEFAULT_MAX_POLL_MS=1_200_000，
  // 见 minimax-h3-video-provider.ts）+ V6 创建重试上界 ~2.3min ≈ 22.4min。
  // 为图片调低 LNKPI_GENERATION_REAP_MINUTES 时，正在生成中的视频不得被误判孤儿
  // 退款（否则「视频最终成功 + 已退款」＝漏扣费）。
  it('video 与 image 解耦：调低 LNKPI_GENERATION_REAP_MINUTES 不影响 video', async () => {
    process.env.LNKPI_GENERATION_REAP_MINUTES = '5'
    // 同龄 15min：image 按 5min 阈值该收；video 按自身默认 30min 不该收
    seed({
      id: 'img-15min',
      type: 'image',
      metadata: makeMeta(),
      createdAt: new Date(Date.now() - 15 * 60_000),
    })
    seed({
      id: 'vid-15min',
      type: 'video',
      metadata: makeMeta(),
      createdAt: new Date(Date.now() - 15 * 60_000),
    })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    const reapedIds = generationUpdateMany.mock.calls.map((c) => c[0].where.id)
    expect(reapedIds).toEqual(['img-15min'])

    // 结构断言：video 独立成组，cutoff 按默认 30min（不是被调低的 5min）
    const videoCall = generationFindMany.mock.calls.find(
      (c) => c[0].where.type.in.length === 1 && c[0].where.type.in[0] === 'video',
    )
    expect(videoCall).toBeDefined()
    const ageMs = Date.now() - videoCall[0].where.createdAt.lt.getTime()
    expect(ageMs).toBeGreaterThan(29 * 60_000)
    expect(ageMs).toBeLessThan(31 * 60_000)
  })

  it('video 阈值可被 LNKPI_VIDEO_REAP_MINUTES 覆盖', async () => {
    // ⚠️ 用 8min（低于默认 30min）：旧实现忽略该 env、按 30min ⇒ 15min 的记录收不到
    // ⇒ 测试红；若设成高于 30min 的值，旧实现也会「收不到」而假绿。
    process.env.LNKPI_VIDEO_REAP_MINUTES = '8'
    seed({
      id: 'vid-15min',
      type: 'video',
      metadata: makeMeta(),
      createdAt: new Date(Date.now() - 15 * 60_000),
    })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    const videoCall = generationFindMany.mock.calls.find(
      (c) => c[0].where.type.in.length === 1 && c[0].where.type.in[0] === 'video',
    )
    expect(videoCall).toBeDefined()
    const ageMs = Date.now() - videoCall[0].where.createdAt.lt.getTime()
    expect(ageMs).toBeGreaterThan(7 * 60_000)
    expect(ageMs).toBeLessThan(9 * 60_000)
  })

  // ── text（Task 4）：依赖 Task 3 的 record-first 让text 产生 generating 态 ──
  it('text 孤儿：回收并退款，文案「文本生成-超时回收退款」，分类 text', async () => {
    seed({
      id: 'rec-text-1',
      type: 'text',
      userId: 'u1',
      model: 'agnes-2.0-flash',
      metadata: JSON.stringify({ chargedPoints: 5 }),
    })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    const data = generationUpdateMany.mock.calls[0][0].data
    expect(data.status).toBe('failed')
    expect(JSON.parse(String(data.metadata)).errorCode).toBe('upstream_timeout')
    expect(refundInTx).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      5,
      '文本生成-超时回收退款',
      expect.objectContaining({ category: 'text', generationId: 'rec-text-1', status: 'failed_refund' }),
    )
  })

  it('text 走独立的 10min 阈值（不是图片的 30min）', async () => {
    // 15 分钟前的 text 记录：超10min 未超 30min ⇒ 只有按10min 扫 text 才收得到
    seed({
      id: 'text-15min',
      type: 'text',
      metadata: makeMeta(),
      createdAt: new Date(Date.now() - 15 * 60_000),
    })
    // 同龄的 image 记录不该被收（图片阈值仍是 30min）
    seed({ id: 'image-15min', type: 'image', metadata: makeMeta(), createdAt: new Date(Date.now() - 15 * 60_000) })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    const reapedIds = generationUpdateMany.mock.calls.map((c) => c[0].where.id)
    expect(reapedIds).toEqual(['text-15min'])

    // 文本那组的 cutoff 确实按 10min 算（第三组：图片 / 视频 / 文本）
    const textWhere = generationFindMany.mock.calls[2][0].where
    expect(textWhere.type).toEqual({ in: ['text'] })
    expect(Date.now() - textWhere.createdAt.lt.getTime()).toBeGreaterThan(9 * 60_000)
    expect(Date.now() - textWhere.createdAt.lt.getTime()).toBeLessThan(11 * 60_000)
  })

  it('text 阈值可被 LNKPI_TEXT_REAP_MINUTES 覆盖', async () => {
    process.env.LNKPI_TEXT_REAP_MINUTES = '45'
    seed({
      id: 'text-15min',
      type: 'text',
      metadata: makeMeta(),
      createdAt: new Date(Date.now() - 15 * 60_000),
    })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(0)
    expect(refundInTx).not.toHaveBeenCalled()
  })

  it('text 孤儿同样受 generating 状态守卫保护（已completed 不动）', async () => {
    seed({ id: 'text-done', type: 'text', metadata: makeMeta(), status: 'completed' })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(0)
    expect(generationUpdateMany).not.toHaveBeenCalled()
    expect(refundInTx).not.toHaveBeenCalled()
  })

  it('text BYOK 孤儿：退款状态用 byok_refund', async () => {
    seed({ id: 'text-byok', type: 'text', metadata: makeMeta({ providerSource: 'user' }) })

    await svc.reapOnce('manual')

    expect(refundInTx.mock.calls[0][4].status).toBe('byok_refund')
    expect(refundInTx.mock.calls[0][4].category).toBe('text')
  })

  it('audio 孤儿纳入回收（2026-11-03 五轮：music completeMusic detached + P1-B job 化）', async () => {
    seed({ id: 'a1', type: 'audio', metadata: makeMeta() })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(1)
    expect(generationUpdateMany).toHaveBeenCalledTimes(1)
    expect(generationUpdateMany.mock.calls[0][0].where.id).toBe('a1')
    // 退款文案与扣费侧同源；分类 audio（point-categories 直通映射）
    expect(refundInTx.mock.calls[0][3]).toContain('音频生成-超时回收退款')
    expect(refundInTx.mock.calls[0][4].category).toBe('audio')
  })
})

describe('GenerationReaperService 无记录孤儿 generating 节点兜底（P0-d）', () => {
  /** 画布节点（最小形态：id + data）。 */
  interface FakeNode {
    id: string
    data: Record<string, unknown>
  }
  let svc: GenerationReaperService
  let mergeNodeData: ReturnType<typeof vi.fn>
  /** 会话桩：id → { canvasData, updatedAt }；scan where 的预筛在桩里如实复刻。 */
  let sessions: Array<{ id: string; canvasData: string; updatedAt: Date }>
  let sessionFindMany: ReturnType<typeof vi.fn>

  function canvasOf(nodes: FakeNode[]): string {
    return JSON.stringify({ nodes, edges: [] })
  }

  function seedSession(id: string, nodes: FakeNode[], updatedAtMs = Date.now() - 60 * 60_000): void {
    sessions.push({ id, canvasData: canvasOf(nodes), updatedAt: new Date(updatedAtMs) })
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    sessions = []
    mergeNodeData = vi.fn(async () => 'applied' as const)
    sessionFindMany = vi.fn(
      async (args: {
        where: { updatedAt: { gte: Date }; canvasData: { contains: string } }
        take: number
      }) => {
        // 如实复刻预筛契约：updatedAt 窗口 + canvasData 含 generating 字样
        return sessions
          .filter(
            (s) =>
              s.updatedAt >= args.where.updatedAt.gte &&
              s.canvasData.includes(args.where.canvasData.contains),
          )
          .slice(0, args.take)
          .map((s) => ({ id: s.id, canvasData: s.canvasData }))
      },
    )
    const prismaMock = {
      generationRecord: { findMany: vi.fn(async () => []) },
      session: { findMany: sessionFindMany },
      $transaction: vi.fn(),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        GenerationReaperService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: PointsService, useValue: { refundInTx: vi.fn() } },
        // B2/孤儿对账的节点写者（Optional 注入，必须显式提供才会走扫描）
        {
          provide: CanvasNodeStatusService,
          useValue: { mergeNodeData, reconcileTerminal: vi.fn(async () => 'applied' as const) },
        },
      ],
    }).compile()
    svc = moduleRef.get(GenerationReaperService)
  })

  it('孤儿 generating 节点（无 recordId + startedAt 超阈值）→ 置 error', async () => {
    seedSession('s1', [
      {
        id: 'audio-1',
        data: {
          status: 'generating',
          generationStartedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        },
      },
    ])

    const n = await svc.reapOnce('manual')

    expect(n).toBe(0) // 记录回收计数不含节点兜底
    expect(mergeNodeData).toHaveBeenCalledTimes(1)
    expect(mergeNodeData.mock.calls[0][0]).toBe('s1')
    expect(mergeNodeData.mock.calls[0][1]).toBe('audio-1')
    expect(mergeNodeData.mock.calls[0][2].status).toBe('error')
  })

  it('有 generationRecordId 的 generating 节点不归本扫描管（B2 对账职责）', async () => {
    seedSession('s1', [
      {
        id: 'image-1',
        data: {
          status: 'generating',
          generationRecordId: 'rec-1',
          generationStartedAt: new Date(Date.now() - 8 * 60 * 60_000).toISOString(),
        },
      },
    ])

    await svc.reapOnce('manual')

    expect(mergeNodeData).not.toHaveBeenCalled()
  })

  it('startedAt 在阈值内（正常生成中）不动', async () => {
    seedSession('s1', [
      {
        id: 'audio-1',
        data: {
          status: 'generating',
          generationStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      },
    ])

    await svc.reapOnce('manual')

    expect(mergeNodeData).not.toHaveBeenCalled()
  })

  it('无 generationStartedAt 的历史残留保守跳过（无时刻证据不判死）', async () => {
    seedSession('s1', [{ id: 'audio-1', data: { status: 'generating' } }])

    await svc.reapOnce('manual')

    expect(mergeNodeData).not.toHaveBeenCalled()
  })

  it('completed/failed 节点不是孤儿；画布 JSON 损坏跳过不炸', async () => {
    seedSession('s1', [
      { id: 'audio-1', data: { status: 'completed' } },
      { id: 'audio-2', data: { status: 'failed' } },
    ])
    sessions.push({ id: 's-broken', canvasData: '{not-json', updatedAt: new Date() })

    await svc.reapOnce('manual')

    expect(mergeNodeData).not.toHaveBeenCalled()
  })
})
describe('video 回收阈值 × 跨层超时预算（单一来源锁）', () => {
  it('reaper 默认阈值必须 ≥ 服务端最坏总耗时 + 5min 缓冲', () => {
    // reaper 阈值小于服务端最坏生成耗时 ⇒ 会把**在生成的视频**判成孤儿并退款，
    // 视频随后完成 ⇒ 「用户拿到视频 + 拿到退款」＝漏扣费。
    // VIDEO_SERVER_WORST_MS 由 @lnkpi/shared/generationTimeoutBudget 派生
    // （MiniMax H3 轮询 deadline + V6 创建重试上界）；agent/web 改预算会即时
    // 反映到这里，防止三层静默失衡。
    expect(DEFAULT_VIDEO_REAP_MINUTES * 60_000).toBeGreaterThanOrEqual(
      VIDEO_SERVER_WORST_MS + 5 * 60_000,
    )
  })
})
describe('GenerationReaperService 终态通报快节拍（job-generation-notify）', () => {
  const env = { ...process.env }
  let handlers: Map<
    string,
    (params: Record<string, unknown>, ctx: { runId: string; reason: string }) => Promise<unknown>
  >
  let svc: GenerationReaperService

  beforeEach(async () => {
    process.env = { ...env }
    handlers = new Map()
    const moduleRef = await Test.createTestingModule({
      providers: [
        GenerationReaperService,
        { provide: PrismaService, useValue: { generationRecord: {} } },
        { provide: PointsService, useValue: {} },
        {
          provide: AutomationSchedulerService,
          useValue: {
            registerHandler: vi.fn(
              (
                key: string,
                handler: (
                  params: Record<string, unknown>,
                  ctx: { runId: string; reason: string },
                ) => Promise<unknown>,
              ) => {
                handlers.set(key, handler)
              },
            ),
          },
        },
      ],
    }).compile()
    svc = moduleRef.get(GenerationReaperService)
  })

  afterEach(() => {
    process.env = env
    notifyScanMock.mockReset()
  })

  function tickNotify(): Promise<unknown> {
    const handler = handlers.get('generation-notify')
    expect(handler, 'generation-notify handler 必须已注册').toBeDefined()
    return handler!({}, { runId: 'run-test', reason: 'scheduled' })
  }

  it('onModuleInit 注册 generation-reaper 与 generation-notify 两个 handler', () => {
    svc.onModuleInit()
    expect(handlers.has('generation-reaper')).toBe(true)
    expect(handlers.has('generation-notify')).toBe(true)
  })

  it('快节拍：扫描未通报终态记录并走同一扫描函数（含 arm/onDelivered 钩子）', async () => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:30100'
    svc.onModuleInit()
    notifyScanMock.mockResolvedValueOnce(2)

    await tickNotify()

    expect(notifyScanMock).toHaveBeenCalledTimes(1)
    // 钩子签名必须齐：快节拍与 reaper 巡检共用同一组装（订阅先于触发 + 投影记账）
    const opts = notifyScanMock.mock.calls[0][3] as {
      onDelivered?: (threadId: string) => void
      onBeforeNotify?: (threadId: string) => Promise<void> | void
    }
    expect(typeof opts?.onDelivered).toBe('function')
    expect(typeof opts?.onBeforeNotify).toBe('function')
    expect(opts.onDelivered).not.toThrow()
  })

  it('单飞守卫：扫描在飞时第二次调用跳过；完成后守卫释放', async () => {
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:30100'
    svc.onModuleInit()
    let release!: () => void
    notifyScanMock.mockImplementationOnce(
      () => new Promise<number>((resolve) => {
        release = () => resolve(0)
      }),
    )

    const first = tickNotify()
    const second = tickNotify() // 在飞 ⇒ 直接跳过（不排队、不重入）
    await second
    expect(notifyScanMock).toHaveBeenCalledTimes(1)

    release()
    await first
    expect(notifyScanMock).toHaveBeenCalledTimes(1)

    await tickNotify() // 守卫已释放 ⇒ 正常再扫
    expect(notifyScanMock).toHaveBeenCalledTimes(2)
  })

  it('快节拍不设 PI_RUNTIME_URL ⇒ 通报关闭，零调用', async () => {
    delete process.env.PI_RUNTIME_URL
    svc.onModuleInit()

    await tickNotify()

    expect(notifyScanMock).not.toHaveBeenCalled()
  })

  describe('E1 terminal-write-tap 集成（终态写点 → 即时通报）', () => {
    let localBus: TerminalEventBus
    let e1Svc: GenerationReaperService
    let e1Prisma: {
      generationRecord: { findMany: ReturnType<typeof vi.fn> }
      $transaction: ReturnType<typeof vi.fn>
    }
    let e1Refund: ReturnType<typeof vi.fn>
    let notifySpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      // E1 路径需要 piLateNotifyEnabled() 为真：置 PI_RUNTIME_URL（本块不依赖真实 runtime）。
      process.env.PI_RUNTIME_URL = 'http://localhost:9999'
      notifyMetrics.reset()
      localBus = new TerminalEventBus()
      e1Refund = vi.fn(async () => {})
      e1Prisma = {
        generationRecord: { findMany: vi.fn(async () => []) },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<number>) =>
          fn({ generationRecord: { updateMany: vi.fn() } }),
        ),
      }
      // 直接构造并注入本地总线实例（隔离全局单例），第 5 参 = bus。
      e1Svc = new GenerationReaperService(
        e1Prisma as never,
        { refundInTx: e1Refund } as never,
        undefined,
        undefined,
        localBus as never,
      )
      notifySpy = vi.spyOn(e1Svc as never, 'notifyTerminalsOnce')
      notifyScanMock.mockResolvedValue(0)
    })

    it('总线 emitTerminalized → onModuleInit 订阅触发 notifyTerminalsOnce("terminal-write")', async () => {
      e1Svc.onModuleInit()
      localBus.emitTerminalized()
      await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledWith('terminal-write'))
    })

    it('通报命中记录数按 NotifyReason 累加（G-1 口径：计记录数非扫描次数）', async () => {
      e1Svc.onModuleInit()
      notifyScanMock.mockResolvedValueOnce(4)
      localBus.emitTerminalized()
      await vi.waitFor(() =>
        expect(notifyMetrics.snapshot().notified['terminal-write']).toBe(4),
      )
      const snap = notifyMetrics.snapshot()
      expect(snap.notified['terminal-write']).toBe(4)
      // 扫描次数口径未启用：notified 记的是「已通报记录数」，不是「扫了几轮」。
      expect(snap.scans['terminal-write'] ?? 0).toBe(0)
    })

    it('零命中（notify 返回 0）不计入度量，杜绝真空通过', async () => {
      e1Svc.onModuleInit()
      notifyScanMock.mockResolvedValueOnce(0)
      localBus.emitTerminalized()
      await vi.waitFor(() => expect(notifyScanMock).toHaveBeenCalled())
      expect(notifyMetrics.snapshot().notified['terminal-write'] ?? 0).toBe(0)
    })

    it('未订阅（未调 onModuleInit）时 emit 不触发通报', async () => {
      // 直接构造但未初始化：总线无订阅者，emit 不触发任何回调。
      localBus.emitTerminalized()
      await new Promise((r) => setTimeout(r, 10))
      expect(notifySpy).not.toHaveBeenCalled()
    })
  })
})

