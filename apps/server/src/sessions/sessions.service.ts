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
        title: title || '未命名项目',
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

  /** pending_confirm 的合法客户端出口（显式确认 patch 序列 + clear-propose）；终态一律无权直达。 */
  private static readonly PENDING_CONFIRM_CLIENT_EXITS = new Set(['pending_confirm', 'draft', 'generating'])

  /**
   * 2026-10-13 虚假确认事故（cmv51vwpu0008p801hxaxcf8m）：浏览器整份 PUT 把
   * 服务端 pending_confirm 盖回旧终态 completed，runtime 轮询误读为「已确认自起生成」
   * （零生成，模型却被告知出图中）。守卫：pending_confirm 节点的客户端 status 只允许
   * 合法出口，违规**字段级**保留服务端值（其余字段照常落库，不 409 整单）。
   * 仅挂浏览器 PUT —— agent/生成链路走 agent-canvas-tools 的 persist，不经过本函数。
   */
  private guardPendingConfirmStatuses(prevRaw: string | null, next: unknown): unknown {
    const nextCanvas = next as { nodes?: Array<{ id?: string; data?: Record<string, unknown> }> } | null
    if (!nextCanvas || !Array.isArray(nextCanvas.nodes)) return next
    let prevNodes: Map<string, { data?: { status?: unknown } }> | undefined
    try {
      const prevCanvas =
        typeof prevRaw === 'string'
          ? (JSON.parse(prevRaw) as { nodes?: Array<{ id?: string; data?: { status?: unknown } }> })
          : null
      if (prevCanvas && Array.isArray(prevCanvas.nodes)) {
        prevNodes = new Map(
          prevCanvas.nodes
            .filter((n) => typeof n?.id === 'string')
            .map((n) => [n.id as string, n]),
        )
      }
    } catch {
      return next // 旧数据脏：守卫直通，保存优先
    }
    if (!prevNodes) return next
    for (const node of nextCanvas.nodes) {
      const prevNode = typeof node?.id === 'string' ? prevNodes.get(node.id) : undefined
      if (prevNode?.data?.status !== 'pending_confirm') continue
      const status = node?.data?.status
      if (typeof status !== 'string' || !SessionsService.PENDING_CONFIRM_CLIENT_EXITS.has(status)) {
        node.data = { ...(node.data ?? {}), status: 'pending_confirm' }
      }
    }
    return next
  }

  async update(id: string, userId: string, data: { title?: string; canvasData?: unknown }) {
    const session = await this.prisma.session.findUnique({ where: { id } })
    if (!session) throw new NotFoundException('会话不存在')
    if (session.userId !== userId) throw new ForbiddenException()

    const updated = await this.prisma.session.update({
      where: { id },
      data: {
        title: data.title,
        canvasData: data.canvasData
          ? JSON.stringify(this.guardPendingConfirmStatuses(session.canvasData, data.canvasData))
          : undefined,
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
        title: `${src.title || '未命名项目'} 副本`,
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
