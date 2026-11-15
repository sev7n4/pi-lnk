// apps/server/src/pricing/pricing-announcement.service.ts
// 调价公告生成器（2026-11-15-pricing-change-announcement-design）。
// 触发面唯一：PricingPublishingService.publish() 成功后（事务外，物化不触发）。
// notifyUsers=false（用户拍板默认值）时 publish 不生成公告，审计日志记录该选择。
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { TEXT_TOKEN_KEY_PATTERN } from './pricing.core'

/** 公告明细条目（payload 数组元素；设计稿 §3）。 */
export interface AnnouncementChangeItem {
  capability: string
  modelKey: string
  displayName: string
  spec: string
  specLabel: string
  from: number
  to: number
  /** 变化率（to-from)/from，from=0（新增）时 null。 */
  pct: number | null
  kind: 'increase' | 'decrease' | 'new'
}

interface EntryLike {
  matchKey: string
  subjectKey: string | null
  capability: string
  credits: number
}

/** 明细条数上限（设计稿 §4 降级：超出折叠为摘要行）。 */
export const MAX_PAYLOAD_ITEMS = 500
/** Top N 展示条数（前端首屏展开数，生成侧不做截断——payload 存全量）。 */
export const TOP_N = 8

/** spec 人话化（设计稿 §5.3）。 */
export function specLabelOf(capability: string, spec: string): string {
  if (capability === 'text') {
    const m: Record<string, string> = { in: '输入', out: '输出', cache: '缓存' }
    return `${m[spec] ?? spec}（每百万 token）`
  }
  if (/^\d{3,4}p:\d+s$/.test(spec)) {
    const [res, dur] = spec.split(':')
    return `${res} · ${dur.replace('s', ' 秒')}`
  }
  if (capability === 'audio') {
    if (spec === 'music') return '音乐（每首）'
    if (spec === 'voice' || spec === 'design') return `${spec === 'voice' ? '语音' : '设计'}（每百字符）`
  }
  if (capability === 'image' && /^\d+K$/.test(spec)) return `${spec}（每张）`
  return spec
}

/**
 * 纯函数：两版本 entries → 用户可感知变更明细（等价金标准源：publish 后公告明细必须与本函数
 * 输出一致）。过滤降噪（设计稿 §5）：
 * 1. 只公告主体行（subjectKey 非空）+ 文本反比率行（matchKey `text:<model>:<spec>`）——
 *    legacy-equivalent 行不在当前扣费路径上（P1 后扣费走主体行），公告只制造噪音；
 * 2. |Δcredits| ≥ 1 分才入明细（0 成本 → 0 分等语义性变化仍满足 |Δ|≥1）；
 * 3. 新增行（active 无同 key 行）kind='new'，from=0、pct=null。
 */
export function buildChangeDetails(
  fromEntries: EntryLike[],
  toEntries: EntryLike[],
  displayNameByModel: Map<string, string>,
): AnnouncementChangeItem[] {
  const fromMap = new Map(fromEntries.map((e) => [e.matchKey, e]))
  const items: AnnouncementChangeItem[] = []
  for (const de of toEntries) {
    const perceptible = de.subjectKey != null || TEXT_TOKEN_KEY_PATTERN.test(de.matchKey)
    if (!perceptible) continue
    const ae = fromMap.get(de.matchKey)
    if (ae && ae.credits === de.credits) continue
    // matchKey 形态：主体行 `capability|modelKey|spec|…`；文本反比率行 `text:<model>:<spec>`
    let capability = de.capability
    let modelKey = ''
    let spec = ''
    if (de.subjectKey != null) {
      const parts = (de.subjectKey ?? de.matchKey).split('|')
      capability = parts[0] ?? de.capability
      modelKey = parts[1] ?? ''
      spec = parts[2] ?? ''
    } else {
      const rest = de.matchKey.slice('text:'.length)
      const sep = rest.lastIndexOf(':')
      modelKey = rest.slice(0, sep)
      spec = rest.slice(sep + 1)
      capability = 'text' // TEXT_TOKEN_KEY_PATTERN 只放行 in/cache/out，capability 恒 text
    }
    if (!modelKey) continue
    items.push({
      capability,
      modelKey,
      displayName: displayNameByModel.get(modelKey) ?? modelKey,
      spec,
      specLabel: specLabelOf(capability, spec),
      from: ae ? ae.credits : 0,
      to: de.credits,
      pct: ae && ae.credits > 0 ? (de.credits - ae.credits) / ae.credits : null,
      kind: !ae ? 'new' : de.credits > ae.credits ? 'increase' : 'decrease',
    })
  }
  // 按 |Δ| 降序（新增行视为最大感知项之一：|Δ| = to）
  items.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
  return items
}

/** 摘要文案（设计稿 §3：人话摘要）。 */
export function summarize(items: AnnouncementChangeItem[]): string {
  const ups = items.filter((i) => i.kind === 'increase').length
  const downs = items.filter((i) => i.kind === 'decrease').length
  const news = items.filter((i) => i.kind === 'new').length
  const parts: string[] = []
  if (ups > 0) parts.push(`${ups} 档涨价`)
  if (downs > 0) parts.push(`${downs} 档降价`)
  if (news > 0) parts.push(`${news} 档新增`)
  const pcts = items.filter((i) => i.pct != null).map((i) => i.pct as number)
  let tail = ''
  if (pcts.length > 0) {
    const maxUp = Math.max(...pcts)
    const maxDown = Math.min(...pcts)
    if (maxUp > 0) tail += `最高涨幅 ${Math.round(maxUp * 100)}%`
    if (maxDown < 0) tail += (tail ? '、' : '') + `最高降幅 ${Math.round(Math.abs(maxDown) * 100)}%`
  }
  return parts.length > 0 ? `${parts.join('、')}${tail ? '，' + tail : ''}` : tail
}

@Injectable()
export class PricingAnnouncementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * publish 成功后调用（notifyUsers=true 时）：diff 旧 active vs 新 active，
   * 有用户可感知变化 ⇒ 写单条聚合公告；无变化 ⇒ 不生成（改了成本但利润抵消等）。
   * 返回公告 id（未生成返回 null），供 publish 审计留痕。
   */
  async generateForPublish(fromVersionId: string | null, toVersionId: string): Promise<string | null> {
    const [fromEntries, toVersion, catalog] = await Promise.all([
      fromVersionId
        ? this.prisma.priceListEntry.findMany({ where: { versionId: fromVersionId } })
        : Promise.resolve([]),
      this.prisma.priceListVersion.findUnique({ where: { id: toVersionId }, include: { entries: true } }),
      this.prisma.modelCatalogEntry.findMany({ where: { deletedAt: null }, select: { modelKey: true, displayName: true } }),
    ])
    if (!toVersion) return null
    const displayNameByModel = new Map(catalog.map((c) => [c.modelKey, c.displayName]))
    const details = buildChangeDetails(fromEntries, toVersion.entries, displayNameByModel)
    if (details.length === 0) return null
    const truncated = details.length > MAX_PAYLOAD_ITEMS ? details.slice(0, MAX_PAYLOAD_ITEMS) : details
    const created = await this.prisma.announcement.create({
      data: {
        type: 'pricing-change',
        versionFrom: fromVersionId,
        versionTo: toVersionId,
        title: '部分模型积分价格调整',
        summary: summarize(details),
        payload: JSON.stringify(truncated),
        effectiveAt: toVersion.publishedAt ?? new Date(),
      },
    })
    return created.id
  }
}
