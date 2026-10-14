/**
 * 价目表种子入口（prisma 惯例位置，供 `pnpm db:seed:pricing` 手跑与测试引用）。
 *
 * 实现位于 src/pricing/seed-pricing.ts——seed 逻辑消费 pricing.core/pricing.space，
 * 属定价域代码；且 src 外文件无法被 src/pricing/pricing.service.ts 静态 import
 * （tsconfig rootDir=src，跨目录 import 触发 TS6059）。本文件只做 re-export + 手跑入口。
 */
import { PrismaClient } from '@prisma/client'
import { seedPricing } from '../src/pricing/seed-pricing'

export * from '../src/pricing/seed-pricing'

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
