// apps/server/src/pricing/announcements.controller.ts
// 调价公告用户端点（2026-11-15-pricing-change-announcement-design §8）。
// 登录用户拉取（横幅/铃铛共用）+ 明细 + 已读（幂等）。列表默认不含 payload 明细
// （横幅只需标题/摘要；明细走 GET :id，降噪传输）。
import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { PrismaService } from '../prisma/prisma.service'

@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @UseGuards(AuthGuard)
  async list(
    @Req() req: { user: { sub: string } },
    @Query('unreadOnly') unreadOnlyRaw?: string,
  ) {
    const userId = req.user.sub
    const unreadOnly = unreadOnlyRaw === '1' || unreadOnlyRaw === 'true'
    const announcements = await this.prisma.announcement.findMany({
      where: { type: 'pricing-change' },
      orderBy: { publishedAt: 'desc' },
      take: 50,
    })
    const reads = await this.prisma.announcementRead.findMany({
      where: { userId, announcementId: { in: announcements.map((a) => a.id) } },
      select: { announcementId: true },
    })
    const readSet = new Set(reads.map((r) => r.announcementId))
    const items = announcements
      .map((a) => ({
        id: a.id,
        type: a.type,
        title: a.title,
        summary: a.summary,
        publishedAt: a.publishedAt,
        effectiveAt: a.effectiveAt,
        read: readSet.has(a.id),
      }))
      .filter((a) => (unreadOnly ? !a.read : true))
    return { code: 0, message: 'ok', data: { items, unreadCount: readSet.size === 0 ? announcements.length : announcements.length - readSet.size } }
  }

  @Get(':id')
  @UseGuards(AuthGuard)
  async detail(@Req() req: { user: { sub: string } }, @Param('id') id: string) {
    const a = await this.prisma.announcement.findUnique({ where: { id } })
    if (!a) throw new NotFoundException(`公告不存在: ${id}`)
    const read = await this.prisma.announcementRead.findUnique({
      where: { announcementId_userId: { announcementId: id, userId: req.user.sub } },
    })
    let items: unknown[] = []
    try {
      const parsed = JSON.parse(a.payload)
      if (Array.isArray(parsed)) items = parsed
    } catch {
      // payload 损坏按空明细返回（历史种子数据兼容），不让公告页白屏
    }
    return {
      code: 0,
      message: 'ok',
      data: {
        id: a.id,
        type: a.type,
        title: a.title,
        summary: a.summary,
        payload: items,
        publishedAt: a.publishedAt,
        effectiveAt: a.effectiveAt,
        read: read != null,
      },
    }
  }

  /** 已读：幂等 upsert（重复 read 不报错、不清他人已读）。 */
  @Post(':id/read')
  @UseGuards(AuthGuard)
  async markRead(@Req() req: { user: { sub: string } }, @Param('id') id: string, @Body() _body: Record<string, unknown>) {
    const a = await this.prisma.announcement.findUnique({ where: { id }, select: { id: true } })
    if (!a) throw new NotFoundException(`公告不存在: ${id}`)
    await this.prisma.announcementRead.upsert({
      where: { announcementId_userId: { announcementId: id, userId: req.user.sub } },
      create: { announcementId: id, userId: req.user.sub },
      update: {},
    })
    return { code: 0, message: 'ok', data: { id, read: true } }
  }
}
