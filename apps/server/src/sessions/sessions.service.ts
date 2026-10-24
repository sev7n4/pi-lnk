import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
// 2026-10-25：与 `CanvasService.list` 共用同一套封面抽取口径（响应体不带 canvasData）。
import { readCover } from '../canvas/canvas-cover'

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

  /**
   * 列表（「我的项目」/ 发布选项目）：**只回卡片级字段，不带 canvasData**。
   *
   * ⭐ 2026-10-25 取证：旧实现 `findMany` 不带 `select` ⇒ 每条把整份画布 JSON
   *   （`canvasData`）序列化返回，165 个项目时整包 **589KB**，还要对每条各做一次
   *   `JSON.parse`。代价不只是慢：一次几百 KB 的传输中途若链路静默死亡（代理 / NAT
   *   残留），TCP 连接既不完成也不报错，Chrome 对单 host 的 6 条 HTTP/1.1 连接被这类
   *   僵尸占满 ⇒ 后续一切请求（含项目抽屉的列表）排队饿死，「项目加载中」转不完。
   *
   * 封面与 `CanvasService.list`（`GET /agent/canvas/list`）**同一套抽取口径**
   * （`canvas-cover.ts`）：DB 层读 canvasData 只为在服务端解析出 `coverUrl`，
   * 响应体里不出现 canvasData —— 否则同一项目在抽屉里和主页卡片上会显示不同封面。
   *
   * 需要整份画布请走 `findOne` —— 它仍返回全量 canvasData，不受本瘦身影响。
   */
  async findAll(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
        // 只为了在服务端解析出封面：这个字段**不会**出现在响应体里。
        canvasData: true,
      },
    })
    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      userId: s.userId,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      coverUrl: readCover(s.canvasData).coverUrl,
    }))
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
