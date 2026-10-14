/**
 * legacy 定价符号导入守卫（P0 等价迁移 · 防回归防线）。
 *
 * 目的：防止未来有人绕过 PricingService 直接 import/使用现行计价常量
 * （「表外静默走旧价」防线，对应 Review Focus：表外静默走旧价 / fallback 假绿）。
 *
 * 合法白名单（三层，均为架构必需）：
 * 1. `*.test.ts` —— 测试文件允许 import 这些符号做金标准对照
 *    （pricing.core.test.ts / video-credits.test.ts / studio.service.test.ts 等）；
 * 2. `src/pricing/pricing.core.ts` —— 唯一合法生产委托出口（legacyPriceOf 的实现处）；
 * 3. `src/points/video-credits.ts` —— legacy 定义文件本身（pricing.core 的委托对象）。
 *    守卫防的是「新增使用方」，定义文件不可能也不应被消除（常量兜底依赖它）。
 *
 * 不在守卫范围：falH3MaxVideoRecordMeta / minimaxH3VideoRecordMeta（record meta 类型，
 * 非定价符号）、P1_IMAGE_EDIT_MODEL_KEY（model key 常量，测试广泛使用）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = path.resolve(__dirname, '..')

/** 现行计价常量（等价迁移后只允许经 pricing.core.ts 委托触及）。 */
const LEGACY_PRICING_SYMBOLS = [
  'videoCreditsForModel',
  'imageGenerationCredits',
  'IMAGE_EDIT_MODEL_PRICING',
] as const

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full))
    } else if (full.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('legacy 定价符号导入守卫', () => {
  const allFiles = collectTsFiles(SRC_ROOT)
  const whitelisted = new Set([
    path.resolve(__dirname, 'pricing.core.ts'),
    path.resolve(SRC_ROOT, 'points/video-credits.ts'),
  ])
  const guardedFiles = allFiles.filter((f) => !f.endsWith('.test.ts') && !whitelisted.has(f))
  // 内容只读一次缓存：本机高负载下 readFileSync ~36ms/个（曾实测 3 轮重读 16-18s，超默认 5s 超时）
  const contents = new Map(guardedFiles.map((f) => [f, readFileSync(f, 'utf8')]))

  it('扫描全集非空（防空集假绿 + 防空根目录）', () => {
    // apps/server/src 实际有几百个 .ts 文件；根目录写错会导致全集为空、否定断言恒真
    expect(allFiles.length).toBeGreaterThan(100)
  })

  it('正向对照：pricing.core.ts 在全集内且 import 三个 legacy 符号（证明根目录/符号名/排除逻辑正确）', () => {
    const corePath = path.resolve(__dirname, 'pricing.core.ts')
    expect(allFiles).toContain(corePath)
    const core = readFileSync(corePath, 'utf8')
    for (const symbol of LEGACY_PRICING_SYMBOLS) {
      expect(core, `pricing.core.ts 应 import ${symbol}`).toMatch(
        new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from`),
      )
    }
  })

  // 裁决偏离（同 pricing.seed.integration.test.ts 惯例）：本机 4 核高负载，
  // 首次收集 312 个文件即使缓存后仍可能超 vitest 默认 5s；只放宽超时，断言体不变。
  it.each(LEGACY_PRICING_SYMBOLS)('生产代码不得直接使用 legacy 定价符号 %s', (symbol) => {
    const pattern = new RegExp(`\\b${symbol}\\b`)
    const hits = guardedFiles.filter((f) => pattern.test(contents.get(f)!))
    expect(
      hits,
      `以下文件直接引用了 legacy 定价符号 ${symbol}，应改走 PricingService.quote：\n${hits.join('\n')}`,
    ).toEqual([])
  }, 60_000)
})
