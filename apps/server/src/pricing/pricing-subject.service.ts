// apps/server/src/pricing/pricing-subject.service.ts
import { Injectable } from '@nestjs/common'
import { modelOptionName } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { incSubject } from './pricing-metrics'
import {
  ENUMERATED_IMAGE_RESOLUTIONS,
  ENUMERATED_IMAGE_COUNTS,
  ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL,
  ENUMERATED_VIDEO_DURATIONS,
  enumerateTextTokenRows,
} from './pricing.space'

/**
 * 上游路由行（结构兼容 shared 的 `UpstreamRouteSeed`；这里用最小结构声明，避免
 * 与 shared 类型强耦合——传入的 `UPSTREAM_ROUTE_SEEDS` 超集可赋值）。
 */
export type RouteRow = {
  matchType: string
  pattern: string | null
  capability: string
  upstream: string
  priority: number
  enabled: boolean
}

export interface SubjectRow {
  subjectKey: string
  capability: string
  modelKey: string
  spec: string
  provider: string
  upstream: string
  channelId: string
  status: string
  billableUnit: string
  unitsPerRequest: number | null
  source: string
}

/** providerBinding → 默认 provider（缺省 agnes_hub）。2026-11-24 加 voicestudio 本地引擎。 */
const PROVIDER_BY_BINDING: Record<string, string> = {
  'gateway-openai-compat': 'agnes_hub',
  'fal-http': 'fal',
  'minimax-http': 'minimax',
  'zhipu-http': 'zhipu',
  'voicestudio-http': 'voicestudio',
}

/**
 * subjectKey 六段归一：`capability|modelKey|spec|provider|upstream`。
 * modelKey 先经 `modelOptionName` 剥离 `platform::` / `chN::` 渠道前缀并转小写，
 * 保证同一模型不同渠道前缀落到同一条主体键（价格锁契约前提）。
 */
export function subjectKeyOf(i: {
  capability: string
  modelKey: string
  spec: string
  provider: string
  upstream: string
}): string {
  return [i.capability, modelOptionName(i.modelKey).trim().toLowerCase(), i.spec, i.provider, i.upstream].join('|')
}

/**
 * 路由解析：按 priority 降序，命中 first-match（default 恒命中）；
 * 未命中任何 enabled 行时兜底 agnes_hub。U6 的 seedance-* 等无专属行 ⇒ 落 default
 * 家族（agnes_hub），family 归一（videoPriceFamily）在 Task 3 的 resolveUnitCost。
 */
export function resolveUpstream(modelKey: string, capability: string, routes: RouteRow[]): string {
  const key = modelOptionName(modelKey).trim().toLowerCase()
  const hit = routes
    .filter((r) => r.enabled && (r.capability === '*' || r.capability === capability))
    .sort((a, b) => b.priority - a.priority)
    .find((r) => {
      if (r.matchType === 'default') return true
      if (r.matchType === 'exact') return key === (r.pattern ?? '').toLowerCase()
      if (r.matchType === 'prefix') return key.startsWith((r.pattern ?? '').toLowerCase())
      if (r.matchType === 'regex') return new RegExp(r.pattern ?? '').test(key)
      return false
    })
  return hit?.upstream ?? 'agnes_hub'
}

/**
 * 两路枚举：
 *  - 非文本模态（image/video/audio）走 enumeratePricingSpace() 风格的档位笛卡尔积；
 *  - 文本模态走 enumerateTextTokenRows()（in/out/cache 反比率行），漏掉会丢 23 条精确
 *    计费主体（R7：实为 23 行，非文件内过时注释的 14 行）。
 * BYOK 不产生主体。U6 family 归一不在本任务（仅登记 upstream，不存 family 字段）。
 */
export function buildSubjectRows(
  catalog: {
    modelKey: string
    modality: string
    providerBinding: string
    audioKind?: string | null
    byok?: boolean
  }[],
  routes: RouteRow[],
): SubjectRow[] {
  const out: SubjectRow[] = []
  for (const m of catalog) {
    if (m.byok) continue
    const model = modelOptionName(m.modelKey).trim().toLowerCase()
    const provider = PROVIDER_BY_BINDING[m.providerBinding] ?? 'agnes_hub'
    const upstream = resolveUpstream(m.modelKey, m.modality, routes)
    const specs: { capability: string; spec: string; billableUnit: string; unitsPerRequest: number | null }[] = []
    if (m.modality === 'text') {
      for (const t of enumerateTextTokenRows()) {
        if (t.modelKey !== model) continue
        specs.push({ capability: 'text', spec: t.spec, billableUnit: `token_${t.spec}`, unitsPerRequest: null })
      }
    } else if (m.modality === 'image') {
      for (const res of ENUMERATED_IMAGE_RESOLUTIONS) {
        for (const count of ENUMERATED_IMAGE_COUNTS) {
          specs.push({ capability: 'image', spec: `${res}:${count}`, billableUnit: 'image_count', unitsPerRequest: count })
        }
      }
      specs.push({ capability: 'image_variant', spec: '*', billableUnit: 'image_count', unitsPerRequest: 1 })
      specs.push({ capability: 'image_edit', spec: '*', billableUnit: 'image_count', unitsPerRequest: 1 })
    } else if (m.modality === 'video') {
      for (const res of ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL) {
        for (const duration of ENUMERATED_VIDEO_DURATIONS) {
          specs.push({ capability: 'video', spec: `${res}:${duration}s`, billableUnit: 'video_call', unitsPerRequest: 1 })
        }
      }
    } else if (m.modality === 'audio') {
      const kind = m.audioKind ?? 'voice'
      specs.push({
        capability: 'audio',
        spec: kind,
        billableUnit: kind === 'music' ? 'song' : 'chars_100',
        unitsPerRequest: kind === 'music' ? 1 : null,
      })
    }
    for (const s of specs) {
      out.push({
        subjectKey: subjectKeyOf({ capability: s.capability, modelKey: model, spec: s.spec, provider, upstream }),
        capability: s.capability,
        modelKey: model,
        spec: s.spec,
        provider,
        upstream,
        channelId: 'platform',
        status: 'draft',
        billableUnit: s.billableUnit,
        unitsPerRequest: s.unitsPerRequest,
        source: 'auto',
      })
    }
  }
  return out
}

@Injectable()
export class PricingSubjectService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 以 ModelCatalogEntry（deletedAt IS NULL）为唯一真源，重建 PricingSubject 主体行。
   * 幂等：subjectKey 已存在则跳过（绝不覆盖人工覆写的 provider / defaultSubjectKey）。
   * 返回新增 / 未变数量；missingInCatalog 预留（本任务不删除已下架主体）。
   */
  async rebuild() {
    const catalog = await this.prisma.modelCatalogEntry.findMany({ where: { deletedAt: null } })
    const routes = await this.prisma.upstreamRoute.findMany({ where: { enabled: true } })
    const rows = buildSubjectRows(
      catalog.map((c) => ({ modelKey: c.modelKey, modality: c.modality, providerBinding: c.providerBinding, audioKind: c.audioKind, byok: false })),
      routes,
    )
    let added = 0
    let unchanged = 0
    for (const r of rows) {
      const hit = await this.prisma.pricingSubject.findUnique({ where: { subjectKey: r.subjectKey } })
      if (hit) {
        unchanged++
        continue
      }
      await this.prisma.pricingSubject.create({ data: r })
      added++
    }
    // 指标：PricingSubject 状态分布（spec §9）。rebuild 是主体真源的唯一写入口，
    // 重建后快照一次状态分布即可，无需逐行 bump。
    const byStatus = await this.prisma.pricingSubject.groupBy({ by: ['status'], _count: { _all: true } })
    for (const g of byStatus) incSubject(g.status)
    await this.prisma.adminAuditLog.create({
      data: {
        actor: 'admin',
        action: 'pricing-subject.rebuild',
        resource: 'pricing-subject',
        before: null,
        after: JSON.stringify({ added, unchanged }),
      },
    })
    return { added, unchanged, missingInCatalog: [] as string[] }
  }
}
