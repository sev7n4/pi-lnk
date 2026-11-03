import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { CanvasData } from '@lnkpi/shared'
import { applyCanvasActions } from '@lnkpi/agent'
// 2026-10-25：与 `CanvasService.list` 共用同一套封面抽取口径（响应体不带 canvasData）。
import { readCover } from '../canvas/canvas-cover'
// P1-C C1a（§3.1）：PATCH ops 白名单收敛。
import { sanitizeClientOps } from './sessions-canvas-patch'

function parseCanvas(raw: string | null | undefined): CanvasData {
  if (!raw) return { nodes: [], edges: [] }
  try {
    const parsed = JSON.parse(raw) as CanvasData
    return {
      ...parsed,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name)

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

  async update(id: string, userId: string, data: { title?: string; canvasData?: unknown }) {
    const session = await this.prisma.session.findUnique({ where: { id } })
    if (!session) throw new NotFoundException('会话不存在')
    if (session.userId !== userId) throw new ForbiddenException()

    // P1-C C2②（规格 §4.2）：整份 PUT 的 canvasData 写入已关闭——画布数据唯一合法
    // 落库通道是 `PATCH /sessions/:id/canvas`（op 语义 + 事务 + staged 守卫）。
    // PUT 带 canvasData ⇒ 忽略（返回 200，title 照常落库），打点 canvas_put_rejected
    // 留痕观测残留调用方（现网无真实用户后提前于 ~11-16 执行）。
    if (data.canvasData) {
      const nodes = (data.canvasData as { nodes?: unknown[] } | null)?.nodes
      this.logger.warn(
        `canvas_put_rejected sessionId=${id} nodes=${Array.isArray(nodes) ? nodes.length : -1}`,
      )
    }

    const updated = await this.prisma.session.update({
      where: { id },
      data: { title: data.title },
    })
    return this.formatSession(updated)
  }

  /**
   * P1-C C1a（规格 2026-11-02-p1c-write-path-governance-design §3.1）：
   * `PATCH /sessions/:id/canvas`——ops 级画布写，替代整份 PUT 的主通道。
   *
   * - 载荷 `{ ops: CanvasAction[] }`，复用 `@lnkpi/agent` 的 5 类 op（不发明方言）。
   * - 白名单：`sanitizeClientOps` 剥除服务端字段五键 + 非 whitelisted op；
   *   `remove_node` 对 generating/pending_confirm 节点 ⇒ 409（取消走既有 cancel 通道）。
   * - 落库与 agent persist 同构：`$transaction` 内读当前 canvas → applier.apply →
   *   合并写回；stagedActions 未清空 ⇒ 409（与 persist 同一句话，stage 期间禁止并行写）。
   * - 返回 `{ applied }`（applied = 白名单收敛后的 op 数）。
   */
  async patchCanvas(id: string, userId: string, rawOps: unknown): Promise<{ applied: number }> {
    const session = await this.prisma.session.findUnique({ where: { id } })
    if (!session) throw new NotFoundException('会话不存在')
    if (session.userId !== userId) throw new ForbiddenException()

    const { sanitized } = sanitizeClientOps(rawOps)

    // remove_node 保护：服务端状态节点不允许客户端删（取消语义走 cancel 通道）。
    if (sanitized.some((op) => (op as { type: string }).type === 'remove_node')) {
      const current = parseCanvas(session.canvasData)
      for (const op of sanitized) {
        if ((op as { type: string }).type !== 'remove_node') continue
        const nodeId = (op as { payload?: { id?: unknown } }).payload?.id
        const node =
          typeof nodeId === 'string' ? current.nodes.find((n) => n?.id === nodeId) : undefined
        const status = node?.data?.status
        if (status === 'generating' || status === 'pending_confirm') {
          throw new ConflictException(
            `Node ${String(nodeId)} is ${status}; cancel via the generation cancel channel instead`,
          )
        }
      }
    }

    if (sanitized.length === 0) return { applied: 0 }

    const applied = await this.prisma.$transaction(async (tx) => {
      const row = await tx.session.findUnique({
        where: { id },
        select: { canvasData: true, stagedActions: true },
      })
      if (!row) throw new NotFoundException('会话不存在')
      if (row.stagedActions) {
        throw new ConflictException(
          'Canvas has staged actions pending commit; call commitStage or rollbackStage first',
        )
      }
      const current = parseCanvas(row.canvasData)
      const updated = applyCanvasActions(current, sanitized)
      const merged: CanvasData = { ...current, ...updated }
      await tx.session.update({
        where: { id },
        data: { canvasData: JSON.stringify(merged) },
      })
      return sanitized.length
    })
    return { applied }
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
