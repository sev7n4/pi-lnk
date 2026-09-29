import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class SessionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 新建画布：**不种任何初始节点**（2026-09-29 拍板）。
   * 历史上带 prompt 时会种一个 prompt-1 提示词节点；用户输入的内容改由
   * `initialPrompt` query 预填到侧栏输入框（CanvasPage.consumeAgentLaunchQuery），
   * 故此处删除该种子不丢内容。见 spec 场景 A/B。
   */
  async create(userId: string, title?: string) {
    const session = await this.prisma.session.create({
      data: {
        userId,
        title: title || '未命名画布',
      },
    })

    return this.formatSession(session)
  }

  async findAll(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    })
    return sessions.map((s) => this.formatSession(s))
  }

  async findOne(id: string, userId?: string) {
    const session = await this.prisma.session.findUnique({ where: { id } })
    if (!session) throw new NotFoundException('会话不存在')
    if (userId && session.userId !== userId) {
      throw new ForbiddenException('此画布不属于当前账号')
    }
    return this.formatSession(session)
  }

  async update(id: string, userId: string, data: { title?: string; canvasData?: unknown }) {
    const session = await this.prisma.session.findUnique({ where: { id } })
    if (!session) throw new NotFoundException('会话不存在')
    if (session.userId !== userId) throw new ForbiddenException()

    const updated = await this.prisma.session.update({
      where: { id },
      data: {
        title: data.title,
        canvasData: data.canvasData ? JSON.stringify(data.canvasData) : undefined,
      },
    })
    return this.formatSession(updated)
  }

  async remove(id: string, userId: string) {
    const session = await this.prisma.session.findUnique({ where: { id } })
    if (!session) throw new NotFoundException('会话不存在')
    if (session.userId !== userId) throw new ForbiddenException()
    await this.prisma.session.delete({ where: { id } })
    return { message: '已删除' }
  }

  async removeMany(userId: string, ids: string[]) {
    const uniqueIds = [...new Set(ids.filter(Boolean))]
    if (!uniqueIds.length) return { deleted: 0 }
    const result = await this.prisma.session.deleteMany({
      where: { userId, id: { in: uniqueIds } },
    })
    return { deleted: result.count }
  }

  async duplicate(userId: string, id: string) {
    const src = await this.prisma.session.findFirst({ where: { id, userId } })
    if (!src) throw new NotFoundException('会话不存在')
    const session = await this.prisma.session.create({
      data: {
        userId,
        title: `${src.title || '未命名画布'} 副本`,
        canvasData: src.canvasData,
      },
    })
    return this.formatSession(session)
  }

  private formatSession(session: {
    id: string
    title: string
    userId: string
    canvasData: string | null
    createdAt: Date
    updatedAt: Date
  }) {
    return {
      id: session.id,
      title: session.title,
      userId: session.userId,
      canvasData: session.canvasData ? JSON.parse(session.canvasData) : undefined,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    }
  }
}
