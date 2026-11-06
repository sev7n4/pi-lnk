import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildShareHtml, type ShareTurn } from '@lnkpi/shared'
import { ShareService } from './share.service'
import { ShareRateLimitGuard } from './share-rate-limit.guard'
import type { PrismaService } from '../prisma/prisma.service'

function makePrisma() {
  return {
    conversation_shares: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService
}

const turn = (over: Partial<ShareTurn> = {}): ShareTurn => ({
  id: 't1',
  role: 'user',
  contentText: '你好世界',
  createdAt: 0,
  ...over,
})

describe('buildShareHtml (DOM-free, server 端可渲染)', () => {
  it('在 Node 环境渲染并注入 OG，不引用 DOM API', () => {
    const html = buildShareHtml([turn()], {
      includeOg: true,
      og: { title: 'T', description: 'D', image: 'https://x/o.png' },
    })
    expect(html).toContain('og:title')
    expect(html).toContain('og:description')
    expect(html).toContain('og:image')
    expect(html).not.toMatch(/window\.|document\./)
  })
})

describe('ShareService.createShare', () => {
  let tmp: string
  let prisma: PrismaService
  let svc: ShareService

  beforeEach(async () => {
    tmp = join(tmpdir(), `share-test-${randomUUID()}`)
    process.env.SHARE_DIR = tmp
    await fs.mkdir(tmp, { recursive: true })
    prisma = makePrisma()
    svc = new ShareService(prisma)
  })

  it('双写：返回 /share/ URL、落盘含 OG 的 HTML、落地 DB 行', async () => {
    const res = await svc.createShare('sess-1', [turn()])
    expect(res.shareId).toBeTruthy()
    expect(res.url).toContain('/share/')
    expect(res.url.endsWith(`${res.shareId}.html`)).toBe(true)

    const file = join(tmp, `${res.shareId}.html`)
    const html = await fs.readFile(file, 'utf8')
    expect(html).toContain('og:title')
    expect(html).toContain('你好世界')

    expect(prisma.conversation_shares.create).toHaveBeenCalledTimes(1)
    const arg = (prisma.conversation_shares.create as unknown as { mock: { calls: any[] } }).mock
      .calls[0][0]
    expect(arg.data.sessionId).toBe('sess-1')
    expect(arg.data.staticPath).toBe(file)
    expect(arg.data.expiresAt).toBeInstanceOf(Date)
  })

  it('XSS：恶意文本被转义，脚本不执行', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    const res = await svc.createShare('sess-2', [turn({ contentText: evil })])
    const html = await fs.readFile(join(tmp, `${res.shareId}.html`), 'utf8')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
  })

  it('社交预览优先用会话第一张产物图（旧实现恒用默认 OG 图）', async () => {
    const res = await svc.createShare('sess-og', [
      turn({ parts: [{ type: 'image', url: 'https://cdn/first.png', caption: '海报' }] }),
    ])
    const html = await fs.readFile(join(tmp, `${res.shareId}.html`), 'utf8')
    expect(html).toContain('content="https://cdn/first.png"')
  })

  it('托管页时间固定 UTC+8（容器是 UTC，旧实现慢 8 小时）', async () => {
    const res = await svc.createShare('sess-tz', [
      turn({ createdAt: Date.UTC(2026, 10, 6, 1, 20, 3) }),
    ])
    const html = await fs.readFile(join(tmp, `${res.shareId}.html`), 'utf8')
    expect(html).toContain('2026/11/6 09:20:03')
    expect(html).not.toContain('2026/11/6 01:20:03')
  })

  it('DB 写入失败时清理已落盘静态文件，避免孤儿文件', async () => {
    ;(prisma.conversation_shares.create as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('db down'),
    )
    await expect(svc.createShare('sess-3', [turn()])).rejects.toThrow('db down')
    const files = await fs.readdir(tmp)
    expect(files).toHaveLength(0)
  })
})

describe('ShareService.cleanupExpired', () => {
  it('过期行：删静态文件 + 删 DB 行，返回移除计数', async () => {
    const tmp = join(tmpdir(), `share-clean-${randomUUID()}`)
    process.env.SHARE_DIR = tmp
    await fs.mkdir(tmp, { recursive: true })
    const filePath = join(tmp, 'old.html')
    await fs.writeFile(filePath, '<html></html>')

    const prisma = makePrisma()
    ;(prisma.conversation_shares.findMany as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce([
      { id: 'old', staticPath: filePath },
    ])
    const svc = new ShareService(prisma)

    const removed = await svc.cleanupExpired()
    expect(removed).toBe(1)
    await expect(fs.readFile(filePath)).rejects.toThrow()
    expect(prisma.conversation_shares.delete).toHaveBeenCalledWith({ where: { id: 'old' } })
  })
})

describe('ShareRateLimitGuard', () => {
  it('同用户 60s 内第 11 次请求被 429 拒绝，不同用户不受影响', () => {
    const guard = new ShareRateLimitGuard()
    const ctx = (sub: string) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user: { sub } }) }) }) as any
    for (let i = 0; i < 10; i++) expect(guard.canActivate(ctx('u1'))).toBe(true)
    expect(() => guard.canActivate(ctx('u1'))).toThrow()
    expect(guard.canActivate(ctx('u2'))).toBe(true)
  })

  it('未携带 user 直接拒绝（防御性）', () => {
    const guard = new ShareRateLimitGuard()
    const ctx = ({ switchToHttp: () => ({ getRequest: () => ({}) }) }) as any
    expect(() => guard.canActivate(ctx)).toThrow()
  })
})
