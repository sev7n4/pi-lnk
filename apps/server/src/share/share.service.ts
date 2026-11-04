import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { buildShareHtml, type ShareHtmlOptions, type ShareTurn } from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'

const SHARE_TTL_DAYS = 30
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1h

export interface CreateShareResult {
  shareId: string
  url: string
  staticPath: string
}

/**
 * 会话分享服务：双写 DB + 落盘静态自包含 HTML（含 OG），由 nginx 直出绕过 Nest。
 *
 * ⚠️ DOM-free：buildShareHtml 来自 @lnkpi/shared（纯函数，无 window/document），
 * 本服务不在 server 端复制其实现（跨端单源契约）。
 * ⚠️ TTL 清理用 setInterval（onModuleInit 注册 / onModuleDestroy 清理），无 @nestjs/schedule 依赖。
 */
@Injectable()
export class ShareService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShareService.name)
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // 周期清理过期分享；unref 避免阻塞进程退出（无 @nestjs/schedule 依赖）
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch((e) => this.logger.error('cleanupExpired failed', e))
    }, CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref?.()
  }

  onModuleDestroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  private get shareDir(): string {
    return process.env.SHARE_DIR ?? '/app/share'
  }

  private get publicBaseUrl(): string {
    return (
      process.env.SHARE_PUBLIC_BASE_URL ?? process.env.API_PUBLIC_URL ?? 'http://119.29.173.89:8888'
    )
  }

  private get ogImageUrl(): string {
    return process.env.SHARE_OG_IMAGE_URL ?? `${this.publicBaseUrl}/share-og-default.png`
  }

  /** 由 turns 推导 OG 标题/描述（首条用户文本前 N 字）。 */
  private deriveOg(turns: ShareTurn[]): ShareHtmlOptions['og'] {
    const firstUser = turns.find((t) => t.role === 'user') ?? turns[0]
    const raw =
      firstUser?.contentText ??
      firstUser?.parts
        ?.map((p) => ('text' in p ? p.text : ''))
        .join(' ') ??
      ''
    const title = (raw || '对话分享').slice(0, 60)
    const description = (raw || '来自 lnkpi 的对话分享').slice(0, 100)
    return { title, description, image: this.ogImageUrl }
  }

  /** 双写：① 落盘静态 HTML（含 OG）② 落库。任一失败均回滚另一边的副作用。 */
  async createShare(sessionId: string, turns: ShareTurn[]): Promise<CreateShareResult> {
    const id = randomUUID()
    const staticPath = join(this.shareDir, `${id}.html`)
    const og = this.deriveOg(turns)
    const html = buildShareHtml(turns, { inlineMedia: 'online', includeOg: true, og })

    const expiresAt = new Date(Date.now() + SHARE_TTL_DAYS * 24 * 60 * 60 * 1000)

    // 先落盘；失败直接抛（无 DB 副作用可清理）
    await fs.mkdir(this.shareDir, { recursive: true })
    await fs.writeFile(staticPath, html, 'utf8')

    try {
      await this.prisma.conversation_shares.create({
        data: { id, sessionId, htmlSnapshot: html, staticPath, expiresAt },
      })
    } catch (e) {
      // DB 写入失败：清理已落盘的静态文件，避免孤儿文件
      await fs.unlink(staticPath).catch(() => undefined)
      throw e
    }

    const url = `${this.publicBaseUrl}/share/${id}.html`
    return { shareId: id, url, staticPath }
  }

  async getShareMeta(id: string) {
    const row = await this.prisma.conversation_shares.findUnique({ where: { id } })
    if (!row) return null
    return {
      id: row.id,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      url: `${this.publicBaseUrl}/share/${row.id}.html`,
    }
  }

  /**
   * 清理过期分享：DB 行 + 静态文件原子删除（二者都成功或都记录失败日志）。
   * 先删文件再删库行；任一边失败仅记日志，另一边仍尽力执行（幂等可重跑）。
   */
  async cleanupExpired(): Promise<number> {
    const now = new Date()
    const expired = await this.prisma.conversation_shares.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true, staticPath: true },
    })
    let removed = 0
    for (const row of expired) {
      if (row.staticPath) {
        await fs.unlink(row.staticPath).catch((e) => this.logger.warn(`unlink failed ${row.staticPath}`, e))
      }
      await this.prisma.conversation_shares
        .delete({ where: { id: row.id } })
        .then(() => {
          removed++
        })
        .catch((e) => this.logger.warn(`delete share row failed ${row.id}`, e))
    }
    return removed
  }
}
