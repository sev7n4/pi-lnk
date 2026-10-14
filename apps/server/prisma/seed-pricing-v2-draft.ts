/**
 * v2 拉新期价目草案种子入口（prisma 惯例位置，供 `pnpm db:seed:pricing:v2-draft` 手跑）。
 *
 * 双文件模式照 P0 seed-pricing：实现位于 src/pricing/seed-pricing-v2-draft.ts——
 * seed 逻辑消费 pricing.core/pricing.space，属定价域代码；且 src 外文件无法被
 * src 内模块静态 import（tsconfig rootDir=src ⇒ 跨目录 import 触发 TS6059）。
 * 本文件只做 re-export + 手跑入口。
 *
 * 只造 status='draft' 的 v2-launch 草案；发布走 §8.4 审批流（publish 端点）+ §8.5 灰度。
 */
import { PrismaClient } from '@prisma/client'
import { seedPricingV2Draft } from '../src/pricing/seed-pricing-v2-draft'

export * from '../src/pricing/seed-pricing-v2-draft'

// 单一 client 实例（同 prisma/seed-pricing.ts T4-a 裁决：断开真正干活的那个）
if (process.argv[1] && process.argv[1].endsWith('seed-pricing-v2-draft.ts')) {
  const client = new PrismaClient()
  seedPricingV2Draft(client)
    .then((r) =>
      console.log(`✅ pricing v2 draft seed: ${r.version} draft, changed=${r.changed} copied=${r.copied}`),
    )
    .catch((err) => {
      console.error('❌ pricing v2 draft seed failed:', err)
      process.exitCode = 1
    })
    .finally(() => void client.$disconnect())
}
