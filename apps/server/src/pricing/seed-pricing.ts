/**
 * 价目表种子（P0 · spec §6/§9）。
 *
 * v1 = legacy-equivalent：逐档调 legacyPriceOf 落显式值——表与常量**同源同值**，
 * 这是「等价迁移」的定义。P1 起改价走运营发布流（§8.4），本脚本退役为历史工具。
 *
 * P1-a 起 boot 不再自播种（发布流接管，见 pricing.service.ts）：本函数退役为
 * 手动工具；手动执行：`pnpm --filter @lnkpi/server db:seed:pricing`。
 *
 * 位置说明：实现从 prisma/seed-pricing.ts 迁至 src/pricing/——seed 逻辑消费
 * pricing.core/pricing.space，属定价域；且 src 外文件无法被 pricing.service.ts
 * 静态 import（tsconfig rootDir=src ⇒ 跨目录 import 触发 TS6059）。
 * prisma/seed-pricing.ts 保留为薄入口（re-export + 手跑自运行块）。
 */
import { PrismaClient } from '@prisma/client'
import { buildMatchKey, legacyPriceOf } from './pricing.core'
import { enumeratePricingSpace } from './pricing.space'

export const PRICING_VERSION_V1 = 'v1-legacy-equivalent'

/** 上游官方挂牌成本（spec §2，2026-10-13 各官方定价页实证）。溯源用，P0 不推导售价。 */
export const SEED_COST_RATES = [
  { channel: 'platform', modelKey: 'seedream-5.0-pro', spec: '1K', unit: 'per_image', costYuan: 0.3 },
  { channel: 'platform', modelKey: 'seedream-5.0-pro', spec: '2K', unit: 'per_image', costYuan: 0.6 },
  { channel: 'platform', modelKey: 'seedream-5.0-flash', spec: '1K', unit: 'per_image', costYuan: 0.12 },
  { channel: 'platform', modelKey: 'gpt-image-2', spec: '1024', unit: 'per_image', costYuan: 0.072 },
  { channel: 'platform', modelKey: 'gpt-image-2', spec: '2K', unit: 'per_image', costYuan: 0.572 },
  { channel: 'platform', modelKey: 'gpt-image-2', spec: '4K', unit: 'per_image', costYuan: 2.93 },
  { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:5s', unit: 'per_video', costYuan: 2.86 },
  { channel: 'platform', modelKey: 'minimax-h3', spec: '2k:5s', unit: 'per_video', costYuan: 4.65 },
  { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:10s', unit: 'per_video', costYuan: 5.72 },
  { channel: 'platform', modelKey: 'minimax-h3', spec: '768p:15s', unit: 'per_video', costYuan: 8.58 },
  { channel: 'platform', modelKey: 'h3-max', spec: '480p:5s', unit: 'per_video', costYuan: 1.79, note: 'fal 路线待渠道账单实测' },
  { channel: 'platform', modelKey: 'seedance-2.0-fast', spec: '480p:5s', unit: 'per_video', costYuan: 1.93 },
  { channel: 'platform', modelKey: 'step-tts-mini', spec: 'per_100_chars', unit: 'per_call', costYuan: 0.009 },
  { channel: 'platform', modelKey: 'stepaudio-3-tts', spec: 'per_100_chars', unit: 'per_call', costYuan: 0.025 },
  { channel: 'platform', modelKey: 'minimax-speech-2.8-hd', spec: 'per_100_chars', unit: 'per_call', costYuan: 0.0715, note: '超价格地板，仅 BYOK' },
  { channel: 'platform', modelKey: 'step-3.5-flash', spec: 'per_1m_tokens_in', unit: 'per_1m_tokens', costYuan: 0.7 },
  { channel: 'platform', modelKey: 'step-3.5-flash', spec: 'per_1m_tokens_out', unit: 'per_1m_tokens', costYuan: 2.1 },
  { channel: 'platform', modelKey: 'stepaudio-3-music', spec: 'per_song', unit: 'per_call', costYuan: 0, note: '限免窗口，watchWindow' },
] as const

export async function seedPricing(prisma: PrismaClient): Promise<{ version: string; entries: number }> {
  const space = enumeratePricingSpace()
  if (space.length === 0) throw new Error('seedPricing: 枚举空间为空——拒绝写空价目表（空集假绿防线）')

  // 单active 不变量（承重，勿删）：本函数把 v1 upsert 成 active。若库里已有**其它**
  // active 版本（P1-a 发布流建出来的运营版本），继续 upsert 会造出第二个 active，
  // 而 loadActiveTable 用无序 findFirst，取到哪个不确定 ⇒ 扣费金额随机漂。
  // P1-a 已删除「归档其余 active」的 updateMany（越权改运营版本状态），改为
  // **拒绝并报错**：改价/发布一律走发布流。
  const otherActive = await prisma.priceListVersion.findFirst({
    where: { status: 'active', version: { not: PRICING_VERSION_V1 } },
  })
  if (otherActive) {
    throw new Error(
      `seedPricing: 库中已有其它 active 价目表版本 ${otherActive.version}（${otherActive.id}）——拒绝造第二个 active。请走运营发布流（pricing-publishing.publish / rollback）管理版本状态。`,
    )
  }

  const version = await prisma.priceListVersion.upsert({
    where: { version: PRICING_VERSION_V1 },
    update: { status: 'active' },
    create: {
      version: PRICING_VERSION_V1,
      status: 'active',
      note: 'P0 等价迁移：与代码常量逐档一致（legacy-equivalent）',
      publishedAt: new Date(),
    },
  })

  let entries = 0
  for (const q of space) {
    const matchKey = buildMatchKey(q)
    const credits = legacyPriceOf(q)
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new Error(`seedPricing: 非法积分值 ${matchKey} → ${credits}`)
    }
    await prisma.priceListEntry.upsert({
      where: { versionId_matchKey: { versionId: version.id, matchKey } },
      update: { credits },
      create: { versionId: version.id, capability: q.capability, matchKey, credits, basis: 'legacy-equivalent' },
    })
    entries++
  }

  for (const r of SEED_COST_RATES) {
    await prisma.costRate.upsert({
      where: { channel_modelKey_spec: { channel: r.channel, modelKey: r.modelKey, spec: r.spec } },
      update: { costYuan: r.costYuan, note: 'note' in r ? r.note : null },
      create: { ...r, note: 'note' in r ? r.note : null },
    })
  }
  await prisma.marginPolicy.upsert({
    where: { phase: 'launch' },
    update: { marginBp: 11000, anchorCents: 1 },
    create: { phase: 'launch', anchorCents: 1, marginBp: 11000 },
  })

  // P0 遗物：发布流接管后移除（原「单一 active 版本：其余一律归档」updateMany）——
  // 归档运营版本状态属越权，改为上方事务前的前置检查：已有其它 active ⇒ 拒绝播种。
  return { version: PRICING_VERSION_V1, entries }
}
