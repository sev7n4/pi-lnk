/**
 * 价目表种子（P0 · spec §6/§9）。
 *
 * v1 = legacy-equivalent：逐档调 legacyPriceOf 落显式值——表与常量**同源同值**，
 * 这是「等价迁移」的定义。P1 起改价走运营发布流（§8.4），本脚本退役为历史工具。
 *
 * boot 时若无 active 版本，PricingService 会调用本函数自愈（P0 专属便利，
 * 见 pricing.service.ts 注释）；手动执行：`pnpm --filter @lnkpi/server db:seed:pricing`。
 */
import { PrismaClient } from '@prisma/client'
import { buildMatchKey, legacyPriceOf } from '../src/pricing/pricing.core'
import { enumeratePricingSpace } from '../src/pricing/pricing.space'

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

  // P0 单一 active 版本：其余一律归档（P1 发布流接管后删除本行）
  await prisma.priceListVersion.updateMany({
    where: { status: 'active', version: { not: PRICING_VERSION_V1 } },
    data: { status: 'archived' },
  })
  return { version: PRICING_VERSION_V1, entries }
}

// T4-a 裁决：单一 client 实例——原版 seedPricing(new PrismaClient()) 后
// .finally(() => void new PrismaClient().$disconnect()) 断的是另一个新实例，
// 真正干活的 A 永不断开，`pnpm db:seed:pricing` 会挂起。
if (process.argv[1] && process.argv[1].endsWith('seed-pricing.ts')) {
  const client = new PrismaClient()
  seedPricing(client)
    .then((r) => console.log(`✅ pricing seed: ${r.version} active, ${r.entries} entries`))
    .catch((err) => {
      console.error('❌ pricing seed failed:', err)
      process.exitCode = 1
    })
    .finally(() => void client.$disconnect())
}
