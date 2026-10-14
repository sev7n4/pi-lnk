/**
 * 价目表发布流服务（P1-a T2 · spec 2026-10-14-p1a-pricing-publishing-gray-release）。
 *
 * draft → diff → publish → rollback 单向流；发布流落地后改价不再发版（运营在 draft
 * 上直接改值，publish 单事务切换 active，quote 侧 PricingService 无感）。
 *
 * 语义要点：
 * - publish 全程单 $transaction：draft→active+publishedAt、旧 active→archived、地板校验、
 *   audit 全在事务内；地板违规/空 draft 在事务内 throw ⇒ 状态零变化（任意时刻至多一个 active）。
 * - 地板只约束有 costRateId 的条目：credits < ceil(costYuan × 105) → 400 附违规清单；
 *   costRateId 引用的 CostRate 行缺失 → 跳过地板并记入 missingCost（返回/告警中体现）。
 * - diffSummary 是预览用途，地板违规只算不抛。
 * - rollback：当前 active → archived；「publishedAt 最新且非当前 active 的 archived」→ active。
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/** 成本地板系数：costYuan（元）× 100（分/credit）× 1.05（毛利锚）= 105 */
const FLOOR_MULTIPLIER = 105

export interface DiffSummary {
  draftVersion: string
  activeVersion: string | null
  added: number
  removed: number
  changed: number
  unchanged: number
  maxIncrease: { matchKey: string; from: number; to: number; pct: number } | null
  maxDecrease: { matchKey: string; from: number; to: number; pct: number } | null
  floorViolations: { matchKey: string; credits: number; floor: number }[]
  /** 有 costRateId 引用但 CostRate 行缺失（发布时按跳过地板处理并告警） */
  missingCost: string[]
  /** 无 costRateId 的 changed 条目（地板跳过标注） */
  noCostCoverage: string[]
}

export interface PublishEntryInput {
  matchKey: string
  capability: string
  credits: number
  basis?: string
  costRateId?: string | null
}

interface EntryLike {
  matchKey: string
  capability: string
  credits: number
  basis: string
  costRateId: string | null
}

@Injectable()
export class PricingPublishingService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 从当前 active 版本复制全部 entries（含 basis/costRateId）建新 draft。 */
  async createDraftFromActive(
    version: string,
    note: string,
  ): Promise<{ id: string; version: string; entries: number }> {
    if (!version || version.trim() === '') {
      throw new BadRequestException('version 不能为空')
    }
    const active = await this.prisma.priceListVersion.findFirst({
      where: { status: 'active' },
      include: { entries: true },
    })
    if (!active) {
      throw new BadRequestException('无可复制基线：当前无 active 价目表版本')
    }
    try {
      const created = await this.prisma.priceListVersion.create({
        data: {
          version,
          status: 'draft',
          note,
          entries: {
            create: active.entries.map((e: EntryLike) => ({
              matchKey: e.matchKey,
              capability: e.capability,
              credits: e.credits,
              basis: e.basis,
              costRateId: e.costRateId,
            })),
          },
        },
        include: { entries: true },
      })
      return { id: created.id, version: created.version, entries: created.entries.length }
    } catch (err) {
      // Prisma unique 冲突（version 重名）→ 400
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
        throw new BadRequestException(`版本号已存在: ${version}`)
      }
      throw err
    }
  }

  async listVersions(): Promise<
    Array<{
      id: string
      version: string
      status: string
      note: string | null
      entryCount: number
      publishedAt: Date | null
      createdAt: Date
    }>
  > {
    const rows = await this.prisma.priceListVersion.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { entries: true } } },
    })
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      note: r.note,
      entryCount: r._count.entries,
      publishedAt: r.publishedAt,
      createdAt: r.createdAt,
    }))
  }

  async getDraft(
    draftId: string,
  ): Promise<{ id: string; version: string; status: string; note: string | null; entries: PublishEntryInput[] } | null> {
    const v = await this.prisma.priceListVersion.findUnique({
      where: { id: draftId },
      include: { entries: true },
    })
    if (!v) return null
    return {
      id: v.id,
      version: v.version,
      status: v.status,
      note: v.note,
      entries: v.entries.map((e: EntryLike) => ({
        matchKey: e.matchKey,
        capability: e.capability,
        credits: e.credits,
        basis: e.basis,
        costRateId: e.costRateId,
      })),
    }
  }

  /** 仅 status='draft' 可改；credits 必须 Number.isInteger && > 0。返回写入条数。 */
  async upsertEntries(draftId: string, entries: PublishEntryInput[]): Promise<number> {
    const v = await this.prisma.priceListVersion.findUnique({ where: { id: draftId } })
    if (!v) throw new NotFoundException(`价目表版本不存在: ${draftId}`)
    if (v.status !== 'draft') {
      throw new BadRequestException(`仅 draft 版本可修改（当前 ${v.status}）`)
    }
    for (const e of entries) {
      if (!e.matchKey || !e.capability) {
        throw new BadRequestException(`matchKey/capability 不能为空: ${JSON.stringify(e)}`)
      }
      if (!Number.isInteger(e.credits) || e.credits <= 0) {
        throw new BadRequestException(`credits 必须为正整数: ${e.matchKey}=${e.credits}`)
      }
    }
    for (const e of entries) {
      await this.prisma.priceListEntry.upsert({
        where: { versionId_matchKey: { versionId: draftId, matchKey: e.matchKey } },
        update: {
          capability: e.capability,
          credits: e.credits,
          basis: e.basis ?? 'legacy-equivalent',
          costRateId: e.costRateId ?? null,
        },
        create: {
          versionId: draftId,
          matchKey: e.matchKey,
          capability: e.capability,
          credits: e.credits,
          basis: e.basis ?? 'legacy-equivalent',
          costRateId: e.costRateId ?? null,
        },
      })
    }
    return entries.length
  }

  /** 对比当前 active 的预览摘要。地板违规只算不抛（预览用途）。 */
  async diffSummary(draftId: string): Promise<DiffSummary> {
    const draft = await this.prisma.priceListVersion.findUnique({
      where: { id: draftId },
      include: { entries: true },
    })
    if (!draft) throw new NotFoundException(`价目表版本不存在: ${draftId}`)
    const active = await this.prisma.priceListVersion.findFirst({
      where: { status: 'active' },
      include: { entries: true },
    })
    const draftMap = new Map(draft.entries.map((e: EntryLike) => [e.matchKey, e]))
    const activeMap = new Map((active?.entries ?? []).map((e: EntryLike) => [e.matchKey, e]))

    let added = 0
    let removed = 0
    let changed = 0
    let unchanged = 0
    let maxIncrease: DiffSummary['maxIncrease'] = null
    let maxDecrease: DiffSummary['maxDecrease'] = null
    const noCostCoverage: string[] = []

    for (const [key, de] of draftMap) {
      const ae = activeMap.get(key)
      if (!ae) {
        added++
        continue
      }
      if (ae.credits === de.credits) {
        unchanged++
        continue
      }
      changed++
      const pct = (de.credits - ae.credits) / ae.credits
      if (de.credits > ae.credits) {
        if (!maxIncrease || pct > maxIncrease.pct) {
          maxIncrease = { matchKey: key, from: ae.credits, to: de.credits, pct }
        }
      } else {
        // 降幅最大 = pct 最负
        if (!maxDecrease || pct < maxDecrease.pct) {
          maxDecrease = { matchKey: key, from: ae.credits, to: de.credits, pct }
        }
      }
      if (!de.costRateId) noCostCoverage.push(key)
    }
    for (const key of activeMap.keys()) {
      if (!draftMap.has(key)) removed++
    }

    const { floorViolations, missingCost } = await this.checkFloors(draft.entries as EntryLike[], (m) =>
      this.prisma.costRate.findMany({ where: { id: { in: m } } }),
    )

    return {
      draftVersion: draft.version,
      activeVersion: active?.version ?? null,
      added,
      removed,
      changed,
      unchanged,
      maxIncrease,
      maxDecrease,
      floorViolations,
      missingCost,
      noCostCoverage,
    }
  }

  /**
   * 发布 draft 为 active（单事务，原子）。
   * 事务内：draft 校验（存在/draft 态/非空）→ 地板校验 → draft→active+publishedAt →
   * 旧 active→archived → audit。任一步 throw ⇒ 整个事务回滚，状态零变化。
   */
  async publish(draftId: string): Promise<{ version: string }> {
    return this.prisma.$transaction(async (tx) => {
      const draft = await tx.priceListVersion.findUnique({
        where: { id: draftId },
        include: { entries: true },
      })
      if (!draft) throw new NotFoundException(`价目表版本不存在: ${draftId}`)
      if (draft.status !== 'draft') {
        throw new BadRequestException(`仅 draft 版本可发布（当前 ${draft.status}）`)
      }
      if (draft.entries.length === 0) {
        throw new BadRequestException('draft 条目为空，拒绝发布（空集假绿防线）')
      }

      const { floorViolations, missingCost } = await this.checkFloors(
        draft.entries as EntryLike[],
        (ids) => tx.costRate.findMany({ where: { id: { in: ids } } }),
      )
      if (missingCost.length > 0) {
        console.warn(
          `[pricing-publishing] publish ${draft.version}: ${missingCost.length} 条 costRate 引用缺失，已跳过地板校验: ${missingCost.join(',')}`,
        )
      }
      if (floorViolations.length > 0) {
        const detail = floorViolations
          .map((v) => `${v.matchKey} credits=${v.credits} < floor=${v.floor}`)
          .join('; ')
        throw new BadRequestException(`地板校验失败 ${floorViolations.length} 条: ${detail}`)
      }

      const oldActive = await tx.priceListVersion.findFirst({ where: { status: 'active' } })
      await tx.priceListVersion.updateMany({
        where: { status: 'active', id: { not: draft.id } },
        data: { status: 'archived' },
      })
      const published = await tx.priceListVersion.update({
        where: { id: draft.id },
        data: { status: 'active', publishedAt: new Date() },
      })

      await tx.adminAuditLog.create({
        data: {
          actor: 'admin',
          action: 'pricing-version.publish',
          resource: `price-list-version:${draft.version}`,
          before: oldActive
            ? JSON.stringify({ id: oldActive.id, version: oldActive.version, status: oldActive.status })
            : null,
          after: JSON.stringify({
            id: draft.id,
            version: draft.version,
            status: 'active',
            entryCount: draft.entries.length,
          }),
        },
      })
      return { version: published.version }
    })
  }

  /**
   * 回滚：当前 active → archived；publishedAt 最新且非当前 active 的 archived → active。
   * 无 active 或无可回滚目标 → 400。
   */
  async rollback(): Promise<{ version: string }> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.priceListVersion.findFirst({ where: { status: 'active' } })
      if (!current) {
        throw new BadRequestException('无可回滚目标：当前无 active 价目表版本')
      }
      const target = await tx.priceListVersion.findFirst({
        where: { status: 'archived', id: { not: current.id } },
        orderBy: { publishedAt: 'desc' },
      })
      if (!target) {
        throw new BadRequestException(`无可回滚目标：active 版本 ${current.version} 之前没有已发布版本`)
      }
      await tx.priceListVersion.update({
        where: { id: current.id },
        data: { status: 'archived' },
      })
      // 重新激活时刷新 publishedAt（使链式回滚的「最新 archived」判定始终成立）
      const restored = await tx.priceListVersion.update({
        where: { id: target.id },
        data: { status: 'active', publishedAt: new Date() },
      })
      await tx.adminAuditLog.create({
        data: {
          actor: 'admin',
          action: 'pricing-version.rollback',
          resource: `price-list-version:${restored.version}`,
          before: JSON.stringify({ id: current.id, version: current.version, status: 'active' }),
          after: JSON.stringify({ id: restored.id, version: restored.version, status: 'active' }),
        },
      })
      return { version: restored.version }
    })
  }

  /**
   * 地板校验：仅对有 costRateId 的条目；CostRate 行缺失 → missingCost（跳过地板）；
   * credits < ceil(costYuan × 105) → floorViolations。
   */
  private async checkFloors(
    entries: EntryLike[],
    findRates: (ids: string[]) => Promise<Array<{ id: string; costYuan: number }>>,
  ): Promise<{
    floorViolations: { matchKey: string; credits: number; floor: number }[]
    missingCost: string[]
  }> {
    const floorViolations: { matchKey: string; credits: number; floor: number }[] = []
    const missingCost: string[] = []
    const rateIds = [...new Set(entries.filter((e) => e.costRateId).map((e) => e.costRateId as string))]
    const rates = rateIds.length > 0 ? await findRates(rateIds) : []
    const rateMap = new Map(rates.map((r) => [r.id, r]))
    for (const e of entries) {
      if (!e.costRateId) continue
      const rate = rateMap.get(e.costRateId)
      if (!rate) {
        missingCost.push(e.matchKey)
        continue
      }
      const floor = Math.ceil(rate.costYuan * FLOOR_MULTIPLIER)
      if (e.credits < floor) {
        floorViolations.push({ matchKey: e.matchKey, credits: e.credits, floor })
      }
    }
    return { floorViolations, missingCost }
  }
}
