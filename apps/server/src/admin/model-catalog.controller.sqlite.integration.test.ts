import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient, Prisma } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { UnauthorizedException } from '@nestjs/common'
import { ModelCatalogAdminController } from './model-catalog.controller'
import { AdminTokenGuard } from './admin-token.guard'
import { CryptoService } from '../provider/crypto.service'
import { WebdavService } from '../provider/webdav.service'
import { PrismaService } from '../prisma/prisma.service'
import { ProviderService } from '../provider/provider.service'
import {
  bumpModelCatalogVersion,
  refreshModelCatalogCache,
  readModelCatalogVersion,
  seedModelCatalogEntries,
  __resetModelCatalogStoreForTests,
  __resetModelCatalogVersionForTests,
} from '../provider/model-catalog-store'

/**
 * S2-1b 集成测试（临时 SQLite + prisma db push，B1/S2-1a 同款 harness）：
 * - A5 审计：每次写操作产生含 before/after 的审计行（who/when/before/after）；
 * - 版本 bump：POST/PUT/DELETE 各 +1，失败操作不 bump；竞态两写 → last-write-win + 版本单调；
 * - A2 热更生效：POST → 下一次 provider 调用（bootstrap）镜像与用户可选快照含新条目；
 *   DELETE → 镜像与 selectableTextModels 同步清理（#306 对齐语义，走 DB 目录真源）。
 */

const serverRoot = path.resolve(__dirname, '../..')

function asService(prisma: PrismaClient): PrismaService {
  return prisma as unknown as PrismaService
}

function newAdminController(prisma: PrismaClient): ModelCatalogAdminController {
  // Nest DI 之外直接实例化：controller 只依赖 prisma（B1 model-health 集成测试同形态）。
  return new ModelCatalogAdminController(asService(prisma))
}

function newProviderService(prisma: PrismaClient): ProviderService {
  // bootstrap 路径只用 prisma（toPublicChannel 无密钥行时不碰 crypto）。
  return new ProviderService(
    asService(prisma),
    {} as unknown as CryptoService,
    {} as unknown as WebdavService,
  )
}

// 2026-10-10：agnes-2.5-flash 已入种子（文本默认接位），admin 新增 fixture 换真实不存在的 key。
const NEW_MODEL = {
  modelKey: 'admin-added-model',
  displayName: 'Admin Added Model',
  gatewayModelId: 'admin-added-model',
  modality: 'text',
  providerBinding: 'gateway-openai-compat',
  params: { model: 'native' },
}

describe('ModelCatalogAdminController CRUD + 审计 + 版本（S2-1b A2/A5）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: ModelCatalogAdminController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-catalog-admin-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    controller = newAdminController(prisma)
  })

  afterAll(async () => {
    __resetModelCatalogStoreForTests()
    __resetModelCatalogVersionForTests()
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // 测试间 DB 隔离（同文件共享一个临时库）：清掉本任务写入的三类行 + 进程内标记，
    // 再播种种子目录（26 条），保证每个用例从「已播种、零写操作」的初态出发。
    await prisma.modelCatalogEntry.deleteMany({ where: { modelKey: NEW_MODEL.modelKey } })
    await prisma.adminAuditLog.deleteMany()
    await prisma.modelCatalogVersion.deleteMany()
    __resetModelCatalogStoreForTests()
    __resetModelCatalogVersionForTests()
    await refreshModelCatalogCache(prisma)
  })

  it('A5：POST/PUT/DELETE 各产生审计行（before/after 齐全）且版本单调 +1', async () => {
    expect(await readModelCatalogVersion(prisma)).toBe(0)

    const created = await controller.create(NEW_MODEL)
    expect(created.code).toBe(0)
    expect(created.data.version).toBe(1)
    expect(created.data.entry.modelKey).toBe(NEW_MODEL.modelKey)
    const id = created.data.entry.id

    const updated = await controller.update(id, { displayName: 'Agnes 2.5 Flash（运营改名）' })
    expect(updated.data.version).toBe(2)
    expect(updated.data.entry.displayName).toBe('Agnes 2.5 Flash（运营改名）')

    const removed = await controller.remove(id)
    expect(removed.data.version).toBe(3)

    const audits = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } })
    expect(audits.map((a) => a.action)).toEqual([
      'model-catalog.create',
      'model-catalog.update',
      'model-catalog.delete',
    ])
    for (const a of audits) {
      expect(a.actor).toBe('admin')
      expect(a.resource).toBe(`model-catalog:${NEW_MODEL.modelKey}`)
    }
    // create：before=null；update：before/after 都有且值不同；delete：before 活行、after 软删
    expect(JSON.parse(audits[0]!.before ?? 'null')).toBeNull()
    expect(JSON.parse(audits[0]!.after!)).toMatchObject({ modelKey: NEW_MODEL.modelKey })
    expect(JSON.parse(audits[1]!.before!)).toMatchObject({ displayName: NEW_MODEL.displayName })
    expect(JSON.parse(audits[1]!.after!)).toMatchObject({ displayName: 'Agnes 2.5 Flash（运营改名）' })
    expect(JSON.parse(audits[2]!.before!).deletedAt).toBeNull()
    expect(JSON.parse(audits[2]!.after!).deletedAt).not.toBeNull()

    // GET：全量条目（含软删标记）+ 版本号
    const list = await controller.list()
    expect(list.data.version).toBe(3)
    const row = list.data.entries.find((e: { modelKey: string }) => e.modelKey === NEW_MODEL.modelKey)
    expect(row.deletedAt).not.toBeNull()
  })

  it('失败操作不写审计、不 bump 版本（active 重复 POST 409 / 默认模型 DELETE 400 / 不存在 PUT 404）', async () => {
    const base = await controller.create(NEW_MODEL)
    const beforeVersion = base.data.version

    await expect(controller.create(NEW_MODEL)).rejects.toMatchObject({ status: 409 })
    // 默认模型防呆：text 默认（现= agnes-2.5-flash，随 shared defaultModelKey 切换）
    const defaultRow = await prisma.modelCatalogEntry.findUnique({
      where: { modelKey: 'agnes-2.5-flash' },
    })
    await expect(controller.remove(defaultRow!.id)).rejects.toMatchObject({ status: 400 })
    await expect(controller.update('no-such-id', { displayName: 'x' })).rejects.toMatchObject({
      status: 404,
    })

    expect(await readModelCatalogVersion(prisma)).toBe(beforeVersion)
    expect(await prisma.adminAuditLog.count()).toBe(1) // 只有 base 那次 POST
  })

  it('软删同 key POST = 恢复上架（清 deletedAt + 覆盖字段），审计 before 含 deletedAt', async () => {
    const created = await controller.create(NEW_MODEL)
    await controller.remove(created.data.entry.id)
    const revived = await controller.create(NEW_MODEL)
    expect(revived.data.entry.id).toBe(created.data.entry.id) // 复用同一行
    expect(revived.data.entry.deletedAt).toBeNull()
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'model-catalog.create' },
      orderBy: { createdAt: 'desc' },
    })
    expect(JSON.parse(audit!.before!).deletedAt).not.toBeNull()
    expect(JSON.parse(audit!.after!).deletedAt).toBeNull()
  })

  it('A2 热更：POST → 下一次 provider 调用镜像与可选快照含新条目；DELETE → 同步清理', async () => {
    const service = newProviderService(prisma)
    const userId = 'user-a2'
    // UserAiPreferences.userId 外键指向 User，先建用户行
    await prisma.user.create({ data: { id: userId, phone: '13800000002', nickname: 'a2' } })

    // 首次调用：播种镜像 + 用户快照（当前目录 = 26 条种子）
    const first = await service.bootstrap(userId)
    expect(first.platformChannel.models).toHaveLength(26)
    expect(first.preferences.selectableTextModels).toContain('platform::agnes-2.0-flash')
    expect(first.catalog).toHaveLength(26) // 下发 payload（web 目录来源）

    // 后台新增 → 下一次 provider 调用即生效（无定时器、无重启）
    const created = await controller.create(NEW_MODEL)
    expect(created.code).toBe(0)
    const second = await service.bootstrap(userId)
    const mirrorNames = second.platformChannel.models.map((m) => m.name)
    expect(mirrorNames).toContain(NEW_MODEL.modelKey)
    expect(mirrorNames).toHaveLength(27)
    expect(second.preferences.selectableTextModels).toContain(`platform::${NEW_MODEL.modelKey}`)
    expect(second.catalog.find((e) => e.modelKey === NEW_MODEL.modelKey)).toBeTruthy()

    // 后台下架（软删）→ 镜像与用户快照同步清理（#306 既有对齐语义）
    const removed = await controller.remove(created.data.entry.id)
    expect(removed.code).toBe(0)
    const third = await service.bootstrap(userId)
    expect(third.platformChannel.models.map((m) => m.name)).not.toContain(NEW_MODEL.modelKey)
    expect(third.preferences.selectableTextModels).not.toContain(`platform::${NEW_MODEL.modelKey}`)
    expect(third.catalog.find((e) => e.modelKey === NEW_MODEL.modelKey)).toBeUndefined()
  })

  it('竞态：两写并发 → last-write-win + 版本严格单调 +1/+1（不丢计数）', async () => {
    const created = await controller.create(NEW_MODEL)
    const id = created.data.entry.id
    const versionBefore = created.data.version

    // 两个写操作并发：条目字段各自整体覆盖（后完成者胜），版本计数各自原子 +1
    const [a, b] = await Promise.all([
      controller.update(id, { displayName: '并发写-A' }),
      controller.update(id, { displayName: '并发写-B' }),
    ])
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    const versions = [a.data.version, b.data.version].sort((x, y) => x - y)
    expect(versions).toEqual([versionBefore + 1, versionBefore + 2]) // 单调、无丢失

    const finalRow = await prisma.modelCatalogEntry.findUnique({ where: { id } })
    expect(['并发写-A', '并发写-B']).toContain(finalRow!.displayName) // last-write-win
    expect(await readModelCatalogVersion(prisma)).toBe(versionBefore + 2)

    // 直接竞态 bump：并发 upsert increment 也不丢计数
    const [b1, b2] = await Promise.all([
      bumpModelCatalogVersion(prisma),
      bumpModelCatalogVersion(prisma),
    ])
    expect([b1, b2].sort((x, y) => x - y)).toEqual([versionBefore + 3, versionBefore + 4])
  })

  it('POST 并发兜底：事务内 create 抛 P2002 → 409，零审计零 bump 零落库', async () => {
    // check-then-act 窗口模拟：包装事务 client，让 modelCatalogEntry.create 抛
    // 真实 PrismaClientKnownRequestError('P2002')（@prisma/client 运行时真形态，
    // 对应「查重通过后另一请求/实例同 key 抢先提交 → DB unique(modelKey) 拒绝」）。
    const boom = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`modelKey`)',
      { code: 'P2002', clientVersion: '6.2.1', meta: { target: ['modelKey'] } },
    )
    const originalTransaction = prisma.$transaction.bind(prisma)
    const txSpy = vi.spyOn(prisma, '$transaction').mockImplementation(((cb: unknown) =>
      originalTransaction((tx: Prisma.TransactionClient) => {
        // 原型链包装：只覆写 create 为 P2002，其余 delegate 透传（审计/版本调用不到——
        // create 先抛，事务整体回滚）
        const failingEntry = Object.create(tx.modelCatalogEntry) as PrismaClient['modelCatalogEntry']
        Object.assign(failingEntry, {
          create: async () => {
            throw boom
          },
        })
        const txWithRace = Object.create(tx) as Prisma.TransactionClient
        txWithRace.modelCatalogEntry = failingEntry
        return (cb as (tx: Prisma.TransactionClient) => Promise<unknown>)(txWithRace)
      })) as never)

    try {
      await expect(controller.create(NEW_MODEL)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('modelKey 已存在'),
      })
    } finally {
      txSpy.mockRestore()
    }

    // 失败路径：零审计、零 bump、零落库（事务随异常回滚，缓存刷新未执行）
    expect(await prisma.adminAuditLog.count()).toBe(0)
    expect(await readModelCatalogVersion(prisma)).toBe(0)
    expect(
      await prisma.modelCatalogEntry.findUnique({ where: { modelKey: NEW_MODEL.modelKey } }),
    ).toBeNull()
  })
})

/**
 * B3 遗留②补齐（与 upstream-routes.controller.sqlite.integration.test.ts 的 guard
 * describe 同构）：guard 类已有独立单测，这里锁「路由真的挂了守卫」——
 * ① 四个路由处理器的路由级 `__guards__` 元数据 = [AdminTokenGuard]；
 * ② LNKPI_ADMIN_TOKEN 未设时带任意 Bearer 仍 fail-closed 401（token 匹配才放行）。
 */
describe('ModelCatalogAdminController guard 401（B3 遗留补齐）', () => {
  const originalToken = process.env.LNKPI_ADMIN_TOKEN

  afterAll(() => {
    if (originalToken === undefined) delete process.env.LNKPI_ADMIN_TOKEN
    else process.env.LNKPI_ADMIN_TOKEN = originalToken
  })

  it('GET/POST/PUT/DELETE 处理器都挂 AdminTokenGuard（路由级元数据断言）', () => {
    // Nest 把路由级 guard 写在 GUARDS_METADATA（'__guards__'）下
    for (const handler of [
      ModelCatalogAdminController.prototype.list,
      ModelCatalogAdminController.prototype.create,
      ModelCatalogAdminController.prototype.update,
      ModelCatalogAdminController.prototype.remove,
    ]) {
      const guards = Reflect.getMetadata('__guards__', handler) as unknown[] | undefined
      expect(guards).toEqual([AdminTokenGuard])
    }
  })

  it('env 未设置 → 恒 401（fail-closed，即使带了任意 Bearer）；token 不匹配 → 401', async () => {
    delete process.env.LNKPI_ADMIN_TOKEN
    const moduleRef = await Test.createTestingModule({
      controllers: [ModelCatalogAdminController],
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
