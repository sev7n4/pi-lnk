import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PointsService } from '../points/points.service'
import { PrismaService } from '../prisma/prisma.service'
import { GenerationReaperService } from './generation-reaper.service'

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

    // 三次 findMany：图片侧一组、视频侧一组（V2b 独立阈值）、文本侧一组
    expect(generationFindMany).toHaveBeenCalledTimes(3)
    const imageWhere = generationFindMany.mock.calls[0][0].where
    expect(imageWhere.type).toEqual({ in: ['image', 'image_edit', 'image_upscale'] })
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

  it('audio 不在回收范围（同步链路无 detached）', async () => {
    seed({ id: 'a1', type: 'audio', metadata: makeMeta() })

    const n = await svc.reapOnce('manual')

    expect(n).toBe(0)
    expect(generationUpdateMany).not.toHaveBeenCalled()
  })
})