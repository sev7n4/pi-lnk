/**
 * 白名单灰度发布服务（P1-a T5 · spec 2026-10-13-pricing-baseline-config-design §8.5）。
 *
 * 选一个 draft 价目版本 + 手机号名单建灰度 release；窗口期内名单用户按该版本计价
 * （quote 侧 PricingService 读 status='active' 的 release，Task 3 已就位）。
 *
 * 语义要点：
 * - 空集假绿防线（§8.5 硬规则）：名单命中 0 人 → 400 附完整未命中号码清单，拒绝生效；
 *   否则「灰度发布了但没人走新价」与「灰度生效了」在旧逻辑下长得一样。
 * - 名单 token 原样对 User.phone 精确匹配（不做 +86/横线猜测，录入人以库内存储格式为准）。
 * - 灰度对象必须是 draft 版本：active 版本无需灰度；promote = 对该 draft 执行
 *   PricingPublishingService.publish（事务+地板+audit）+ release 置 promoted。
 * - rollback 只关灰度（release 置 rolled_back，quote 侧天然失效），不回滚版本本身
 *   （版本回退走 publishing.rollback）。
 * - 报告零新增埋点：全部按 PointTransaction.grayReleaseId 聚合流水。
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { PricingPublishingService } from './pricing-publishing.service'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface WhitelistPreview {
  hits: { userId: string; phone: string }[]
  misses: string[]
}

export interface CreateGrayReleaseInput {
  versionId: string
  phones: string[]
  startsAt?: Date
  endsAt?: Date
  note?: string
}

/** 换行/逗号/分号/空格（含全角）切分 → trim → 去空去重（保序）。 */
export function tokenizeWhitelist(rawInput: string | string[]): string[] {
  const raw = Array.isArray(rawInput) ? rawInput.join('\n') : rawInput
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of raw.split(/[\s,;，；]+/)) {
    const t = token.trim()
    if (t === '' || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

@Injectable()
export class PricingGrayReleaseService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly publishing: PricingPublishingService,
  ) {}

  /** 名单预解析：token 原样精确匹配 User.phone，命中/未命中都显式返回。 */
  async previewWhitelist(rawInput: string): Promise<WhitelistPreview> {
    const tokens = tokenizeWhitelist(rawInput)
    if (tokens.length === 0) return { hits: [], misses: [] }
    return this.matchPhones(tokens)
  }

  async createRelease(input: CreateGrayReleaseInput): Promise<{
    releaseId: string
    version: string
    hits: number
    window: { startsAt: Date; endsAt: Date }
  }> {
    const tokens = tokenizeWhitelist(input.phones)
    if (tokens.length === 0) {
      throw new BadRequestException('名单为空：至少需要一个手机号')
    }
    const version = await this.prisma.priceListVersion.findUnique({ where: { id: input.versionId } })
    if (!version) {
      throw new NotFoundException(`价目表版本不存在: ${input.versionId}`)
    }
    if (version.status !== 'draft') {
      throw new BadRequestException(
        `灰度对象必须是 draft 版本（当前 ${version.status}）——active 版本无需灰度`,
      )
    }

    const { hits, misses } = await this.matchPhones(tokens)
    // 空集假绿防线：命中 0 → 400 附完整未命中清单
    if (hits.length === 0) {
      throw new BadRequestException(
        `名单全部未命中，拒绝创建灰度（空集假绿防线）——未命中号码: ${misses.join(', ')}`,
      )
    }

    const startsAt = input.startsAt ?? new Date()
    const endsAt = input.endsAt ?? new Date(startsAt.getTime() + SEVEN_DAYS_MS)
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException(
        `窗口非法：endsAt(${endsAt.toISOString()}) 必须晚于 startsAt(${startsAt.toISOString()})`,
      )
    }

    const existing = await this.prisma.pricingGrayRelease.findFirst({ where: { status: 'active' } })
    if (existing) {
      throw new ConflictException(`已存在进行中的灰度发布 ${existing.id}（单一 active 灰度约束）`)
    }

    const releaseId = await this.prisma.$transaction(async (tx) => {
      const release = await tx.pricingGrayRelease.create({
        data: {
          versionId: version.id,
          status: 'active',
          startsAt,
          endsAt,
          createdBy: 'admin',
          note: input.note ?? null,
        },
      })
      await tx.pricingGrayWhitelist.createMany({
        data: hits.map((h) => ({ releaseId: release.id, userId: h.userId, phone: h.phone })),
      })
      await tx.adminAuditLog.create({
        data: {
          actor: 'admin',
          action: 'pricing-gray.create',
          resource: `pricing-gray-release:${release.id}`,
          before: null,
          after: JSON.stringify({
            releaseId: release.id,
            version: version.version,
            hits: hits.length,
            startsAt,
            endsAt,
            note: input.note ?? null,
          }),
        },
      })
      return release.id
    })

    return { releaseId, version: version.version, hits: hits.length, window: { startsAt, endsAt } }
  }

  /** 列表 + 读时惰性过期：active 且 now > endsAt → 先置 expired 再返回。 */
  async listReleases(): Promise<
    Array<{ id: string; status: string; version: string; hits: number; startsAt: Date; endsAt: Date; note: string | null }>
  > {
    const now = Date.now()
    const rows = await this.prisma.pricingGrayRelease.findMany({
      orderBy: { createdAt: 'desc' },
      include: { version: true, _count: { select: { whitelist: true } } },
    })
    const out: Array<{
      id: string
      status: string
      version: string
      hits: number
      startsAt: Date
      endsAt: Date
      note: string | null
    }> = []
    for (const r of rows) {
      let status = r.status
      if (status === 'active' && now > new Date(r.endsAt).getTime()) {
        await this.prisma.pricingGrayRelease.update({ where: { id: r.id }, data: { status: 'expired' } })
        status = 'expired'
      }
      out.push({
        id: r.id,
        status,
        version: r.version.version,
        hits: r._count.whitelist,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        note: r.note,
      })
    }
    return out
  }

  /** 报告：全部按 PointTransaction.grayReleaseId 聚合（零新增埋点）。 */
  async getReport(releaseId: string): Promise<{
    releaseId: string
    version: string
    status: string
    hits: number
    txCount: number
    txAmountByCategory: Record<string, number>
    refundCount: number
    byUser: Array<{ userId: string; consumeCount: number; consumeTotal: number }>
  }> {
    const rel = await this.prisma.pricingGrayRelease.findUnique({
      where: { id: releaseId },
      include: { version: true, _count: { select: { whitelist: true } } },
    })
    if (!rel) {
      throw new NotFoundException(`灰度发布不存在: ${releaseId}`)
    }
    const txs = await this.prisma.pointTransaction.findMany({ where: { grayReleaseId: releaseId } })

    const txAmountByCategory: Record<string, number> = {}
    const byUserMap = new Map<string, { userId: string; consumeCount: number; consumeTotal: number }>()
    let refundCount = 0
    for (const t of txs) {
      txAmountByCategory[t.category] = (txAmountByCategory[t.category] ?? 0) + t.amount
      if (t.kind === 'refund') refundCount++
      if (t.kind === 'consume') {
        const u = byUserMap.get(t.userId) ?? { userId: t.userId, consumeCount: 0, consumeTotal: 0 }
        u.consumeCount++
        u.consumeTotal += t.amount
        byUserMap.set(t.userId, u)
      }
    }
    const byUser = [...byUserMap.values()].sort(
      (a, b) => b.consumeTotal - a.consumeTotal || a.userId.localeCompare(b.userId),
    )

    return {
      releaseId: rel.id,
      version: rel.version.version,
      status: rel.status,
      hits: rel._count.whitelist,
      txCount: txs.length,
      txAmountByCategory,
      refundCount,
      byUser,
    }
  }

  /** 转正：对灰度版本（仍 draft）执行 publish 流程（事务+地板+audit）+ release 置 promoted。 */
  async promote(releaseId: string): Promise<{ version: string }> {
    const rel = await this.prisma.pricingGrayRelease.findUnique({
      where: { id: releaseId },
      include: { version: true },
    })
    if (!rel) {
      throw new NotFoundException(`灰度发布不存在: ${releaseId}`)
    }
    if (rel.status !== 'active') {
      throw new BadRequestException(`仅 active 灰度可转正（当前 ${rel.status}）`)
    }
    // publish 接收 draftId=versionId（Task 2 的 getDraft/publish 都按 version id 操作）
    const { version } = await this.publishing.publish(rel.versionId)
    await this.prisma.$transaction(async (tx) => {
      await tx.pricingGrayRelease.update({
        where: { id: rel.id },
        data: { status: 'promoted' },
      })
      await tx.adminAuditLog.create({
        data: {
          actor: 'admin',
          action: 'pricing-gray.promote',
          resource: `pricing-gray-release:${rel.id}`,
          before: JSON.stringify({ releaseId: rel.id, version: rel.version.version, status: 'active' }),
          after: JSON.stringify({ releaseId: rel.id, version: rel.version.version, status: 'promoted' }),
        },
      })
    })
    return { version }
  }

  /** 关停灰度：release 置 rolled_back（quote 读 status='active'，名单用户立即回 global）。 */
  async rollback(releaseId: string): Promise<void> {
    const rel = await this.prisma.pricingGrayRelease.findUnique({ where: { id: releaseId } })
    if (!rel) {
      throw new NotFoundException(`灰度发布不存在: ${releaseId}`)
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.pricingGrayRelease.update({
        where: { id: rel.id },
        data: { status: 'rolled_back' },
      })
      await tx.adminAuditLog.create({
        data: {
          actor: 'admin',
          action: 'pricing-gray.rollback',
          resource: `pricing-gray-release:${rel.id}`,
          before: JSON.stringify({ releaseId: rel.id, status: rel.status }),
          after: JSON.stringify({ releaseId: rel.id, status: 'rolled_back' }),
        },
      })
    })
  }

  private async matchPhones(tokens: string[]): Promise<WhitelistPreview> {
    const users = await this.prisma.user.findMany({
      where: { phone: { in: tokens } },
      select: { id: true, phone: true },
    })
    const idByPhone = new Map(users.map((u) => [u.phone, u.id]))
    const hits = tokens
      .filter((t) => idByPhone.has(t))
      .map((t) => ({ userId: idByPhone.get(t)!, phone: t }))
    const misses = tokens.filter((t) => !idByPhone.has(t))
    return { hits, misses }
  }
}
