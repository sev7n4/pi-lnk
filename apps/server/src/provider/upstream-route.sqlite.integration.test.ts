import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  legacyResolveUpstream,
  resolveUpstreamRoute,
  STUDIO_MODEL_CATALOG,
  UPSTREAM_ROUTE_SEEDS,
  type ModelCapability,
} from '@lnkpi/shared'
import {
  loadUpstreamRouteRows,
  refreshUpstreamRouteCache,
  seedUpstreamRoutes,
  currentUpstreamRoutes,
  __registerUpstreamRoutePrismaForTests,
  __resetUpstreamRouteStoreForTests,
} from './upstream-route-store'

/**
 * S2-2a 播种幂等 + DB 路径对拍集成测试（临时 SQLite + prisma db push，真实表结构；
 * model-catalog.sqlite.integration.test.ts 同款 harness）：
 * - 播种幂等：连续两次，行数不变、第二次新插 0 条；
 * - 种子只插不改：人工改动 / 后台新增行不被覆盖；
 * - DB 装载 rows 经 resolveUpstreamRoute ≡ legacyResolveUpstream（全目录 × 4 capability）。
 */

const serverRoot = path.resolve(__dirname, '../..')
const CAPABILITIES: readonly ModelCapability[] = ['text', 'image', 'video', 'audio']

describe('UpstreamRoute 播种幂等 + DB 路径对拍（S2-2a）', () => {
  let dir: string
  let prisma: PrismaClient

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-route-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  })

  afterAll(async () => {
    __resetUpstreamRouteStoreForTests()
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  it('空库首播全部种子行，二次播种行数不变、新插 0 条、内容逐条一致', async () => {
    expect(await seedUpstreamRoutes(prisma)).toBe(UPSTREAM_ROUTE_SEEDS.length)
    expect(await seedUpstreamRoutes(prisma)).toBe(0)
    const rows = await prisma.upstreamRoute.findMany()
    expect(rows).toHaveLength(UPSTREAM_ROUTE_SEEDS.length)
    for (const seed of UPSTREAM_ROUTE_SEEDS) {
      const row = rows.find(
        (r) =>
          r.matchType === seed.matchType &&
          (r.pattern ?? null) === seed.pattern &&
          r.capability === seed.capability &&
          r.upstream === seed.upstream,
      )
      expect(row, `${seed.matchType}:${seed.pattern ?? 'default'}`).toBeDefined()
      expect(row!.priority).toBe(seed.priority)
      expect(row!.enabled).toBe(seed.enabled)
      expect(row!.fallbackApiKeyEnvName ?? null).toBe(seed.fallbackApiKeyEnvName ?? null)
    }
  })

  it('种子只插不改：人工改 pattern/priority、后台新增行，重播后原样存活', async () => {
    await prisma.upstreamRoute.update({
      where: { id: (await prisma.upstreamRoute.findFirst({ where: { matchType: 'regex' } }))!.id },
      data: { priority: 999 },
    })
    await prisma.upstreamRoute.create({
      data: {
        matchType: 'exact',
        pattern: 'admin-added-model-x',
        capability: 'image',
        upstream: 'apimart',
        priority: 50,
        enabled: true,
      },
    })
    expect(await seedUpstreamRoutes(prisma)).toBe(0)
    const edited = await prisma.upstreamRoute.findFirst({ where: { matchType: 'regex' } })
    expect(edited!.priority).toBe(999)
    expect(
      await prisma.upstreamRoute.findFirst({ where: { pattern: 'admin-added-model-x' } }),
    ).not.toBeNull()
  })

  it('DB 装载 rows 解析 ≡ legacyResolveUpstream（全目录 × 4 capability 逐条一致）', async () => {
    const rows = await loadUpstreamRouteRows(prisma)
    expect(rows.length).toBeGreaterThanOrEqual(UPSTREAM_ROUTE_SEEDS.length)
    const mismatches: string[] = []
    let comparisons = 0
    for (const entry of STUDIO_MODEL_CATALOG) {
      for (const cap of CAPABILITIES) {
        const legacy = legacyResolveUpstream(entry.modelKey, cap)
        const routed = resolveUpstreamRoute(rows, entry.modelKey, cap).upstream
        comparisons++
        if (legacy !== routed) {
          mismatches.push(`modelKey="${entry.modelKey}" capability="${cap}": legacy=${legacy} != routed=${routed}`)
        }
      }
    }
    expect(comparisons).toBe(STUDIO_MODEL_CATALOG.length * 4)
    expect(mismatches, mismatches.join('\n')).toEqual([])
  })

  it('server 包装器端到端：注册 prisma + bootstrap 后，DB 行进入缓存参与解析', async () => {
    __registerUpstreamRoutePrismaForTests(prisma)
    await refreshUpstreamRouteCache(prisma)
    const rows = currentUpstreamRoutes()
    expect(rows.length).toBeGreaterThanOrEqual(UPSTREAM_ROUTE_SEEDS.length)
    // 后台新增行（上用例遗留）经缓存可见；人工改 priority 的行同样可见
    const adminRow = rows.find((r) => r.pattern === 'admin-added-model-x')
    expect(adminRow).toBeDefined()
    expect(resolveUpstreamRoute(rows, 'admin-added-model-x', 'image').upstream).toBe('apimart')
  })
})
