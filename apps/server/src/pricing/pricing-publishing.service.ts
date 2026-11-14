/**
 * 价目表发布流服务（P1-a T2 · spec 2026-10-14-p1a-pricing-publishing-gray-release）。
 *
 * draft → diff → publish → rollback 单向流；发布流落地后改价不再发版（运营在 draft
 * 上直接改值，publish 单事务切换 active，quote 侧 PricingService 无感）。
 *
 * 语义要点：
 * - publish 全程单 $transaction：draft→active+publishedAt、旧 active→archived、地板校验、
 *   audit 全在事务内；地板违规/空 draft 在事务内 throw ⇒ 状态零变化（任意时刻至多一个 active）。
 * - 地板只约束有 costRateId 的条目，判定委托 pricing.core.checkCostFloor——价格行判下限、
 *   token 反比率行判上限（同一条「收入 ≥ 成本 × 1.05」的两种量纲展开）→ 400 附违规清单；
 *   costRateId 引用的 CostRate 行缺失 → 跳过地板并记入 missingCost（返回/告警中体现）。
 * - diffSummary 是预览用途，地板违规只算不抛。
 * - rollback：当前 active → archived；「publishedAt 最新且非当前 active 的 archived」→ active。
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { checkCostFloor, isTextTokenMatchKey, type FloorViolation } from './pricing.core'
import { PricingService } from './pricing.service'

/**
 * 草案 vs active 的对比摘要。
 *
 * 无 removed 计数：upsertEntries 不提供删条目能力（「active 有、draft 没有」
 * 永不成立），该四计数之一恒为 0 的死代码已按终审 T2③ 删除（YAGNI）。
 */
export interface DiffSummary {
  draftVersion: string
  activeVersion: string | null
  added: number
  changed: number
  unchanged: number
  maxIncrease: { matchKey: string; from: number; to: number; pct: number } | null
  maxDecrease: { matchKey: string; from: number; to: number; pct: number } | null
  floorViolations: FloorViolation[]
  /** 有 costRateId 引用但 CostRate 行缺失（发布时按跳过地板处理并告警） */
  missingCost: string[]
  /**
   * 全表口径的无 costRateId 条目（未做地板校验）。
   *
   * 不限 changed 分支：v1 的 4s 档本来就没 costRateId（D2），运营日常路径
   * 「复制 active 建草案 + 手工改价」改完仍是 null——若只在 changed 分支采集，
   * 审批人只看到「地板违规 0 条」，看不到任何无成本覆盖提示，易被误当成已校验。
   */
  noCostCoverage: string[]
  /** S1 发布门禁：subject 主体条目缺成本快照（costSnapshotYuan） */
  missingSubject: string[]
  /** S1 发布门禁：非 token 的 subject 条目缺计量单位快照（unitSnapshot） */
  unitMismatch: string[]
  /** S1 发布门禁：条目引用的 marginPolicy 不存在 */
  marginMismatch: string[]
}

/**
 * 运营改价缺省 basis。
 *
 * 「等价于 legacy 常量」与「运营改过价」是互斥语义：经发布流 upsert 的条目属于
 * 后者，缺省必须是 ops-modified。若缺省成legacy-equivalent，改价条目仍带
 * legacy-equivalent 落库 → 发布后 active 版本满足 `legacyRows === totalRows`
 * → 重启走全网等价自检 → 该条目与 legacyPriceOf 失配 → degraded=true → 全站回落
 * 常量兜底，运营改的价被静默丢弃（终审Critical C1）。
 *
 * 种子路径（seed-pricing-v2-draft.ts显式写 launch-reprice / legacy-equivalent）
 * 不经本缺省，不受影响。
 */
export const DEFAULT_OPS_BASIS = 'ops-modified'

export interface PublishEntryInput {
  matchKey: string
  capability: string
  credits: number
  basis?: string
  costRateId?: string | null
  /** S1 六字段：subject 成本主体快照（运营定价真源，发布流显式透传，绝不静默丢） */
  subjectKey?: string | null
  costSnapshotYuan?: number | null
  unitSnapshot?: string | null
  profitBpSnapshot?: number | null
  marginPolicyId?: string | null
  reason?: string | null
}

interface EntryLike {
  matchKey: string
  capability: string
  credits: number
  basis: string
  costRateId: string | null
  subjectKey: string | null
  costSnapshotYuan: number | null
  unitSnapshot: string | null
  profitBpSnapshot: number | null
  marginPolicyId: string | null
  reason: string | null
}

@Injectable()
export class PricingPublishingService {
  // 单向注入 PricingService（写路径 → 计价缓存）。反向不注入：PricingService 不
  // 依赖发布流，双向会成 Nest 循环依赖。
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

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
              subjectKey: e.subjectKey,
              costSnapshotYuan: e.costSnapshotYuan,
              unitSnapshot: e.unitSnapshot,
              profitBpSnapshot: e.profitBpSnapshot,
              marginPolicyId: e.marginPolicyId,
              reason: e.reason,
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
        subjectKey: e.subjectKey,
        costSnapshotYuan: e.costSnapshotYuan,
        unitSnapshot: e.unitSnapshot,
        profitBpSnapshot: e.profitBpSnapshot,
        marginPolicyId: e.marginPolicyId,
        reason: e.reason,
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
          basis: e.basis ?? DEFAULT_OPS_BASIS,
          costRateId: e.costRateId ?? null,
          subjectKey: e.subjectKey ?? null,
          costSnapshotYuan: e.costSnapshotYuan ?? null,
          unitSnapshot: e.unitSnapshot ?? null,
          profitBpSnapshot: e.profitBpSnapshot ?? null,
          marginPolicyId: e.marginPolicyId ?? null,
          reason: e.reason ?? null,
        },
        create: {
          versionId: draftId,
          matchKey: e.matchKey,
          capability: e.capability,
          credits: e.credits,
          basis: e.basis ?? DEFAULT_OPS_BASIS,
          costRateId: e.costRateId ?? null,
          subjectKey: e.subjectKey ?? null,
          costSnapshotYuan: e.costSnapshotYuan ?? null,
          unitSnapshot: e.unitSnapshot ?? null,
          profitBpSnapshot: e.profitBpSnapshot ?? null,
          marginPolicyId: e.marginPolicyId ?? null,
          reason: e.reason ?? null,
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
    let changed = 0
    let unchanged = 0
    let maxIncrease: DiffSummary['maxIncrease'] = null
    let maxDecrease: DiffSummary['maxDecrease'] = null

    // 无成本覆盖走全表口径（不限 changed 分支，见 DiffSummary.noCostCoverage 注释）：
    // v1 的 4s 档本就没 costRateId，运营改价路径下改完仍是 null，只在 changed 分支
    // 采集会让这类条目从审批视野里消失。
    const noCostCoverage: string[] = []
    for (const [key, de] of draftMap) {
      if (!de.costRateId) noCostCoverage.push(key)
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
    }

    const { floorViolations, missingCost, unitMismatch } = await this.checkFloors(
      draft.entries as EntryLike[],
      (m) => this.prisma.costRate.findMany({ where: { id: { in: m } } }),
    )

    // S1 门禁只读汇总：subject 主体缺成本快照 / marginPolicy 引用缺失。
    const missingSubject: string[] = []
    const marginMismatch: string[] = []
    for (const e of draft.entries as EntryLike[]) {
      if (e.subjectKey && (e.costSnapshotYuan === null || e.costSnapshotYuan === undefined)) {
        missingSubject.push(e.matchKey)
      }
      if (e.marginPolicyId) {
        const mp = await this.prisma.marginPolicy.findUnique({ where: { id: e.marginPolicyId } })
        if (!mp) marginMismatch.push(e.matchKey)
      }
    }

    return {
      draftVersion: draft.version,
      activeVersion: active?.version ?? null,
      added,
      changed,
      unchanged,
      maxIncrease,
      maxDecrease,
      floorViolations,
      missingCost,
      noCostCoverage,
      missingSubject,
      unitMismatch,
      marginMismatch,
    }
  }

  /**
   * 发布 draft 为 active（单事务，原子）。
   * 事务内：draft 校验（存在/draft 态/非空）→ 地板校验 → draft→active+publishedAt →
   * 旧 active→archived → audit。任一步 throw ⇒ 整个事务回滚，状态零变化。
   */
  async publish(draftId: string): Promise<{ version: string }> {
    // 发布前门禁（spec §6.8 七条硬拒：空集/非 draft/缺成本主体/计量未对齐/地板违规/
    // 成本引用缺失/marginPolicy 引用缺失）：不通过即带结构化违规清单 400，绝不静默发布。
    const verdict = await this.validatePublish(draftId)
    if (!verdict.ok) {
      throw new BadRequestException(
        `发布校验未通过 ${verdict.violations.length} 条: ${verdict.violations.join('; ')}`,
      )
    }
    const out = await this.prisma.$transaction(async (tx) => {
      // 单一 active 不变量的观察点与写入点同处一个事务首行（终审 Minor M3：
      // 查在事务外、建在事务内，并发 publish 可建出两个 active，而 loadActiveTable
      // 用无序 findFirst 取到哪个不确定）。
      const oldActive = await tx.priceListVersion.findFirst({ where: { status: 'active' } })
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

      // 无成本覆盖（全表口径）：不阻断发布，但必须留痕——否则「无地板违规」这条
      // console/UI 提示会被读成「全部条目都过了地板校验」。
      const uncovered = (draft.entries as EntryLike[]).filter((e) => !e.costRateId)
      if (uncovered.length > 0) {
        console.warn(
          `[pricing-publishing] publish ${draft.version}: ${uncovered.length}/${draft.entries.length} 条无成本覆盖（未做地板校验）`,
        )
      }

      await tx.priceListVersion.updateMany({
        where: { status: 'active', id: { not: draft.id } },
        data: { status: 'archived' },
      })
      // revision + 1：每次发布递增，供调用方/审计识别版本演进（门禁已保证地板/成本主体合规）。
      const published = await tx.priceListVersion.update({
        where: { id: draft.id },
        data: { status: 'active', publishedAt: new Date(), revision: { increment: 1 } },
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
    // 提交成功后清计价缓存：新 active 版本立即对 quote 生效（否则最长 30s 继续
    // 按旧价扣费；终审 Important I3）。事务 throw 时不会走到这里⇒ 失败不改缓存。
    this.pricing.invalidate()
    return out
  }

  /**
   * 回滚：当前 active → archived；publishedAt 最新且非当前 active 的 archived → active。
   * 无 active 或无可回滚目标 → 400。
   */
  async rollback(): Promise<{ version: string }> {
    const out = await this.prisma.$transaction(async (tx) => {
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
        data: { status: 'active', publishedAt: new Date(), revision: { increment: 1 } },
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
    // 同 publish：回滚后立即清缓存，否则最长 30s 仍按被回滚的价扣费。
    this.pricing.invalidate()
    return out
  }

  /**
   * 发布门禁（spec §6.8 七条硬拒）：在 publish 前集中校验，返回结构化违规清单。
   * 任一不满足 → ok=false，publish 据此带清单 400（绝不静默发布、绝不丢弃运营改价）。
   *   1. 版本非 draft 态
   *   2. draft 条目为空（空集假绿防线）
   *   3. subject 主体条目缺成本快照 costSnapshotYuan（缺成本主体）
   *   4. 非 token 的 subject 条目缺计量单位快照 unitSnapshot（计量未对齐）
   *   5. 地板违规（价格行低于下限 / token 反比率高于上限，按归一后成本判）
   *   6. costRateId 引用缺失（成本来源不可解析）
   *   7. marginPolicyId 引用缺失（利润策略不可解析）
   */
  async validatePublish(draftId: string): Promise<{ ok: boolean; violations: string[] }> {
    const draft = await this.prisma.priceListVersion.findUnique({
      where: { id: draftId },
      include: { entries: true },
    })
    if (!draft) throw new NotFoundException(`价目表版本不存在: ${draftId}`)
    const violations: string[] = []
    if (draft.status !== 'draft') {
      violations.push(`版本非 draft 态（当前 ${draft.status}）`)
    }
    if (draft.entries.length === 0) {
      violations.push('draft 条目为空，拒绝发布（空集假绿防线）')
    }
    const entries = draft.entries as EntryLike[]
    // ③ 缺成本主体：subject 行必须有成本快照（否则报价/计费无成本口径）。
    for (const e of entries) {
      if (e.subjectKey && (e.costSnapshotYuan === null || e.costSnapshotYuan === undefined)) {
        violations.push(`条目 ${e.matchKey} 为 subject 主体但缺少成本快照（costSnapshotYuan）`)
      }
    }
    // ④ 计量未对齐：非 token 的 subject 行缺 unitSnapshot。
    for (const e of entries) {
      if (e.subjectKey && !isTextTokenMatchKey(e.matchKey) && (e.unitSnapshot === null || e.unitSnapshot === undefined)) {
        violations.push(`条目 ${e.matchKey} 缺少计量单位快照（unitSnapshot）`)
      }
    }
    // ⑤⑥⑦ 地板 / 成本引用 / marginPolicy 引用。
    const { floorViolations, missingCost } = await this.checkFloors(entries, (ids) =>
      this.prisma.costRate.findMany({ where: { id: { in: ids } } }),
    )
    for (const v of floorViolations) {
      violations.push(
        `地板违规 ${v.matchKey}: credits=${v.credits} ${v.kind === 'max' ? '>' : '<'} ${v.kind === 'max' ? '上限' : '下限'}=${v.limit}`,
      )
    }
    for (const m of missingCost) violations.push(`costRate 引用缺失: ${m}`)
    for (const e of entries) {
      if (e.marginPolicyId) {
        const mp = await this.prisma.marginPolicy.findUnique({ where: { id: e.marginPolicyId } })
        if (!mp) violations.push(`marginPolicy 引用缺失: ${e.marginPolicyId}（条目 ${e.matchKey}）`)
      }
    }
    return { ok: violations.length === 0, violations }
  }

  /**
   * 地板校验：仅对有 costRateId 的条目；CostRate 行缺失 → missingCost（跳过地板，
   * 由上层告警）；其余委托 pricing.core.checkCostFloor——价格行判下限、token 反比率
   * 行判上限（同一条「收入 ≥ 成本 × 1.05」的两种量纲展开）。
   *
   * AC14：subject 主体行用「成本快照 costSnapshotYuan」（归一后成本）判地板，而非
   * CostRate 渠道单价——运营定价真源的成本口径以此为准；token 反比率行仍用
   * rate.costYuan 判上限。priceFloorBp 取自条目 marginPolicyId 指向的策略，缺省 500。
   */
  private async checkFloors(
    entries: EntryLike[],
    findRates: (ids: string[]) => Promise<Array<{ id: string; costYuan: number }>>,
  ): Promise<{
    floorViolations: FloorViolation[]
    missingCost: string[]
    unitMismatch: string[]
  }> {
    const floorViolations: FloorViolation[] = []
    const missingCost: string[] = []
    const unitMismatch: string[] = []
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
      const isToken = isTextTokenMatchKey(e.matchKey)
      // AC14：subject 主体行用成本快照（归一后成本）判地板；token 反比率行用渠道单价判上限。
      const costForFloor = isToken ? rate.costYuan : e.costSnapshotYuan ?? rate.costYuan
      const policy = e.marginPolicyId
        ? await this.prisma.marginPolicy.findUnique({ where: { id: e.marginPolicyId } })
        : null
      const v = checkCostFloor(e, costForFloor, policy?.priceFloorBp ?? 500)
      if (v) floorViolations.push(v)
      // 非 token 的 subject 主体行缺计量单位快照 ⇒ 计量未对齐（spec §6.8 硬拒之一）。
      if (e.subjectKey && !isToken && (e.unitSnapshot === null || e.unitSnapshot === undefined)) {
        unitMismatch.push(e.matchKey)
      }
    }
    return { floorViolations, missingCost, unitMismatch }
  }
}
