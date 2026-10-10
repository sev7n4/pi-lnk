import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { UnauthorizedException } from '@nestjs/common'
import { resolveUpstreamRoute } from '@lnkpi/shared'
import { UpstreamRoutesAdminController } from './upstream-routes.controller'
import { AdminTokenGuard } from './admin-token.guard'
import { PrismaService } from '../prisma/prisma.service'
import {
  currentUpstreamRoutes,
  refreshUpstreamRouteCache,
  seedUpstreamRoutes,
  __registerUpstreamRoutePrismaForTests,
  __resetUpstreamRouteStoreForTests,
} from '../provider/upstream-route-store'

/**
 * S2-2b 路由运营端点集成测试（临时 SQLite + prisma db push，S2-1b 同款 harness）：
 * - GET：全量种子行 + routesVersion；
 * - PUT：行更新 + 审计行（before/after）+ routesVersion 原子 +1 + 本进程缓存立即刷新
 *   （改路由 → 下一次 resolve/探活立即见新路由，不热重启）；
 * - 校验失败（非法 upstream / 危险 regex / 非法 priority / 不存在 id / default 行冲突）
 *   不写库、不审计、不 bump；
 * - guard 401 形态（T2 评审遗留补齐）：路由处理器必须挂 AdminTokenGuard + fail-closed 401。
 */

const serverRoot = path.resolve(__dirname, '../..')

function asService(prisma: PrismaClient): PrismaService {
  return prisma as unknown as PrismaService
}

describe('UpstreamRoutesAdminController（GET/PUT /api/admin/upstream-routes）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: UpstreamRoutesAdminController
  const originalToken = process.env.LNKPI_ADMIN_TOKEN

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-routes-admin-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    controller = new UpstreamRoutesAdminController(asService(prisma))
  })

  afterAll(async () => {
    __resetUpstreamRouteStoreForTests()
    if (originalToken === undefined) delete process.env.LNKPI_ADMIN_TOKEN
    else process.env.LNKPI_ADMIN_TOKEN = originalToken
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // 每用例从「已播种、零写操作」初态出发（同文件共享一个临时库）。
    await prisma.upstreamRoute.deleteMany()
    await prisma.adminAuditLog.deleteMany()
    await prisma.modelCatalogVersion.deleteMany()
    await seedUpstreamRoutes(prisma)
    __resetUpstreamRouteStoreForTests()
    __registerUpstreamRoutePrismaForTests(prisma)
    await refreshUpstreamRouteCache(prisma)
  })

  async function rowIdByPattern(pattern: string): Promise<string> {
    const row = await prisma.upstreamRoute.findFirst({ where: { pattern } })
    expect(row, `seed row ${pattern}`).toBeDefined()
    return row!.id
  }

  it('GET：全量种子行 + version 0（priority 降序）', async () => {
    const res = await controller.list()
    expect(res.code).toBe(0)
    expect(res.data.version).toBe(0)
    const priorities = res.data.routes.map((r: { priority: number }) => r.priority)
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities)
    const minimax = res.data.routes.find((r: { pattern: string | null }) => r.pattern === 'minimax-h3')
    expect(minimax).toMatchObject({ matchType: 'exact', capability: '*', upstream: 'minimax', enabled: true })
  })

  it('PUT：更新 upstream + 审计 before/after + version +1 + 本进程路由立即生效', async () => {
    const id = await rowIdByPattern('minimax-h3')
    expect(resolveUpstreamRoute([...currentUpstreamRoutes()], 'minimax-h3', 'video').upstream).toBe('minimax')

    const res = await controller.update(id, { upstream: 'apimart' })
    expect(res.code).toBe(0)
    expect(res.data.version).toBe(1)
    expect(res.data.route).toMatchObject({ id, upstream: 'apimart', pattern: 'minimax-h3' })

    // 审计行：who/when/before/after
    const audits = await prisma.adminAuditLog.findMany()
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actor: 'admin', action: 'upstream-routes.update', resource: `upstream-routes:${id}` })
    expect(JSON.parse(audits[0]!.before!)).toMatchObject({ upstream: 'minimax' })
    expect(JSON.parse(audits[0]!.after!)).toMatchObject({ upstream: 'apimart' })

    // 版本落库 + 本进程缓存已刷新（下一次 resolve/探活立即见新路由）
    const versionRow = await prisma.modelCatalogVersion.findUnique({ where: { id: 'routes' } })
    expect(versionRow?.version).toBe(1)
    expect(resolveUpstreamRoute([...currentUpstreamRoutes()], 'minimax-h3', 'video').upstream).toBe('apimart')
  })

  it('PUT：改 priority / enabled 同样审计 + bump；enabled=false 后解析不再命中该行', async () => {
    const id = await rowIdByPattern('minimax-h3')
    const res = await controller.update(id, { enabled: false, priority: 99 })
    expect(res.data.version).toBe(1)
    expect(res.data.route).toMatchObject({ enabled: false, priority: 99 })
    expect(resolveUpstreamRoute([...currentUpstreamRoutes()], 'minimax-h3', 'video').upstream).toBe('agnes_hub')
    const audits = await prisma.adminAuditLog.findMany()
    expect(JSON.parse(audits[0]!.before!)).toMatchObject({ enabled: true, priority: 30 })
    expect(JSON.parse(audits[0]!.after!)).toMatchObject({ enabled: false, priority: 99 })
  })

  it('校验失败：非法 upstream / 危险 regex pattern / 非法 priority / 不存在 id —— 400/404 且不审计不 bump', async () => {
    const stepRowId = await rowIdByPattern('step')
    const regexRowId = await rowIdByPattern('h3-max')

    await expect(controller.update(stepRowId, { upstream: 'openai' })).rejects.toMatchObject({ status: 400 })
    // ReDoS 防线：嵌套量词 pattern 被 assertRoutePatternSafe 拒绝
    await expect(controller.update(regexRowId, { pattern: '(a+)+' })).rejects.toMatchObject({ status: 400 })
    await expect(controller.update(stepRowId, { priority: 1.5 })).rejects.toMatchObject({ status: 400 })
    await expect(controller.update('no-such-id', { priority: 1 })).rejects.toMatchObject({ status: 404 })
    // 普通 exact 行不允许 pattern 置空（只有 default 行可以）
    await expect(controller.update(stepRowId, { pattern: null })).rejects.toMatchObject({ status: 400 })

    expect(await prisma.adminAuditLog.count()).toBe(0)
    const versionRow = await prisma.modelCatalogVersion.findUnique({ where: { id: 'routes' } })
    expect(versionRow ?? null).toBeNull()
  })

  it('default 行唯一：把普通行改成 default 而库里已有 default 行 → 409，不落库', async () => {
    const stepRowId = await rowIdByPattern('step')
    await expect(controller.update(stepRowId, { matchType: 'default', pattern: null })).rejects.toMatchObject({
      status: 409,
    })
    expect(await prisma.adminAuditLog.count()).toBe(0)
    // default 行自身可以改 upstream（不触发唯一性冲突）
    const defaultRow = await prisma.upstreamRoute.findFirst({ where: { matchType: 'default' } })
    const res = await controller.update(defaultRow!.id, { upstream: 'apimart' })
    expect(res.data.route).toMatchObject({ matchType: 'default', upstream: 'apimart' })
    expect(res.data.version).toBe(1)
  })
})

describe('UpstreamRoutesAdminController guard 401（T2 评审遗留补齐）', () => {
  const originalToken = process.env.LNKPI_ADMIN_TOKEN

  afterAll(() => {
    if (originalToken === undefined) delete process.env.LNKPI_ADMIN_TOKEN
    else process.env.LNKPI_ADMIN_TOKEN = originalToken
  })

  it('GET/PUT 处理器都挂 AdminTokenGuard（路由级元数据断言）', () => {
    // Nest 把路由级 guard 写在 GUARDS_METADATA（'__guards__'）下
    for (const handler of [UpstreamRoutesAdminController.prototype.list, UpstreamRoutesAdminController.prototype.update]) {
      const guards = Reflect.getMetadata('__guards__', handler) as unknown[] | undefined
      expect(guards).toEqual([AdminTokenGuard])
    }
  })

  it('env 未设置 → 恒 401（fail-closed，即使带了任意 Bearer）；token 不匹配 → 401', async () => {
    delete process.env.LNKPI_ADMIN_TOKEN
    const moduleRef = await Test.createTestingModule({
      controllers: [UpstreamRoutesAdminController],
      providers: [AdminTokenGuard, { provide: PrismaService, useValue: {} }],
    }).compile()
    const guard = moduleRef.get(AdminTokenGuard)
    const ctx = (authorization?: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers: authorization ? { authorization } : {} }) }),
      }) as never

    expect(() => guard.canActivate(ctx('Bearer anything'))).toThrow(UnauthorizedException)
    expect(() => guard.canActivate(ctx(undefined))).toThrow(UnauthorizedException)

    process.env.LNKPI_ADMIN_TOKEN = 'secret-token'
    expect(() => guard.canActivate(ctx('Bearer wrong-token'))).toThrow(UnauthorizedException)
    expect(guard.canActivate(ctx('Bearer secret-token'))).toBe(true)
  })
})
