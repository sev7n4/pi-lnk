// apps/server/src/pricing/announcements.controller.sqlite.integration.test.ts
// 公告用户端点集成测试（2026-11-15-pricing-change-announcement-design §9 判据 3/4）。
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotFoundException } from '@nestjs/common'
import { AnnouncementsController } from './announcements.controller'

const serverRoot = path.resolve(__dirname, '../..')

describe('AnnouncementsController（用户端点）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: AnnouncementsController
  const userA = { user: { sub: 'user-a' } }
  const userB = { user: { sub: 'user-b' } }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-announcements-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    controller = new AnnouncementsController(prisma as never)
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.announcementRead.deleteMany()
    await prisma.announcement.deleteMany()
  })

  async function seed(title: string) {
    return prisma.announcement.create({
      data: {
        type: 'pricing-change',
        versionTo: 'v-x',
        title,
        summary: '2 档涨价、1 档降价',
        payload: JSON.stringify([{ capability: 'video', modelKey: 'h3-max', spec: '768p:5s', from: 45, to: 315, kind: 'increase' }]),
        effectiveAt: new Date(),
      },
    })
  }

  it('list：全量与 unreadOnly 过滤；unreadCount 按 per-user 已读计', async () => {
    const a = await seed('公告一')
    await seed('公告二')
    await controller.markRead(userA, a.id, {})
    const all = await controller.list(userA)
    expect(all.data.items).toHaveLength(2)
    expect(all.data.unreadCount).toBe(1)
    const unread = await controller.list(userA, '1')
    expect(unread.data.items.map((i: { title: string }) => i.title)).toEqual(['公告二'])
    // userB 未读两条
    const b = await controller.list(userB)
    expect(b.data.unreadCount).toBe(2)
  })

  it('detail：payload 明细解析为 items；list 不含 payload（降噪传输）', async () => {
    const a = await seed('明细公告')
    const detail = await controller.detail(userA, a.id)
    expect(detail.data.payload).toHaveLength(1)
    expect((detail.data.payload as Array<{ modelKey: string }>)[0]!.modelKey).toBe('h3-max')
    expect(detail.data.read).toBe(false)
    const list = await controller.list(userA)
    expect((list.data.items as Array<Record<string, unknown>>)[0]).not.toHaveProperty('payload')
  })

  it('markRead 幂等：重复 read 不报错、不清他人已读（§9 判据 3）', async () => {
    const a = await seed('已读公告')
    await controller.markRead(userA, a.id, {})
    await controller.markRead(userA, a.id, {}) // 重复
    expect(await prisma.announcementRead.count({ where: { announcementId: a.id } })).toBe(1)
    await controller.markRead(userB, a.id, {})
    const reread = await controller.markRead(userA, a.id, {}) // userA 再读不影响 userB 已读
    expect(reread.data.read).toBe(true)
    expect(await prisma.announcementRead.count({ where: { announcementId: a.id } })).toBe(2)
    const unreadA = await controller.list(userA, '1')
    expect(unreadA.data.items).toHaveLength(0)
  })

  it('不存在公告：detail/markRead → 404', async () => {
    await expect(controller.detail(userA, 'nope')).rejects.toThrow(NotFoundException)
    await expect(controller.markRead(userA, 'nope', {})).rejects.toThrow(NotFoundException)
  })

  it('payload 损坏按空明细返回（不让公告页白屏）', async () => {
    const a = await prisma.announcement.create({
      data: { type: 'pricing-change', versionTo: 'v-y', title: '坏 payload', payload: 'not-json{', effectiveAt: new Date() },
    })
    const detail = await controller.detail(userA, a.id)
    expect(detail.data.payload).toEqual([])
  })
})
