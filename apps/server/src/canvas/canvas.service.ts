import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/** A3 回访作品带：从 canvasData 里挑出的「最近生成的产物」 */
export interface CanvasCover {
  /** 产物图 URL；无产物时 null（前端用墨鱼默认封面） */
  coverUrl: string | null
  /** 该产物节点 id（前端据此跨项目定位到那张图） */
  coverNodeId: string | null
}

type CanvasNodeLike = {
  id?: unknown
  data?: Record<string, unknown> | null
}

/**
 * A3：挑出「最近生成的产物图」。
 *
 * 事实依据（2026-10-22 生产库实测 canvasData 结构）：
 * - 产物节点 = `data.status === 'completed'` 且 `data.url` 非空
 *   （`status:'error' / 'draft' / 'idle'` 的节点 url 均为空）
 * - 时间序 = `data.generationStartedAt`（ISO 8601 字符串）；
 *   缺该字段时退回 `data.createdAt`，再缺则按节点在数组中的位置兜底。
 *
 * ⚠️ 解析失败（canvasData 为 null / 非法 JSON / 结构异常）一律降级为
 * 「无封面」，**绝不抛错** —— 列表接口因单个脏数据 500 是不可接受的。
 */
function pickLatestArtifact(nodes: unknown): { url: string; nodeId: string } | null {
  if (!Array.isArray(nodes)) return null
  // 收集候选后统一取最大者：闭包内赋值外部 let 会被 TS 的控制流分析判成 never。
  const candidates: Array<{ url: string; nodeId: string; time: number; index: number }> = []
  nodes.forEach((raw, index) => {
    const node = raw as CanvasNodeLike
    if (!node || typeof node !== 'object') return
    const data = node.data
    if (!data || typeof data !== 'object') return
    if (data.status !== 'completed') return
    const url = typeof data.url === 'string' ? data.url.trim() : ''
    if (!url) return
    const nodeId = typeof node.id === 'string' ? node.id : ''
    if (!nodeId) return
    // 时间序：generationStartedAt → createdAt → 数组位置（越靠后越新）
    const rawTime = data.generationStartedAt ?? data.createdAt
    const parsed = typeof rawTime === 'string' ? Date.parse(rawTime) : NaN
    const time = Number.isNaN(parsed) ? index : parsed
    candidates.push({ url, nodeId, time, index })
  })
  if (!candidates.length) return null
  let best = candidates[0]!
  for (const c of candidates.slice(1)) {
    if (c.time > best.time || (c.time === best.time && c.index > best.index)) best = c
  }
  return { url: best.url, nodeId: best.nodeId }
}

function readCover(canvasData: string | null | undefined): CanvasCover {
  if (!canvasData) return { coverUrl: null, coverNodeId: null }
  try {
    const parsed = JSON.parse(canvasData) as { nodes?: unknown }
    const hit = pickLatestArtifact(parsed?.nodes)
    return hit ? { coverUrl: hit.url, coverNodeId: hit.nodeId } : { coverUrl: null, coverNodeId: null }
  } catch {
    return { coverUrl: null, coverNodeId: null }
  }
}

@Injectable()
export class CanvasService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 列表返回卡片元数据（id/title/时间戳）+ A3 封面字段。
   *
   *  2026-10-19 修复：全量返回 canvasData 时 165 个项目可达 2.3MB（下载 6s+），
   *  移动端抽屉项目区长时间空白。**响应体**仍只返回元数据 + 几个 URL 字符串，
   *  原始 canvasData 不出服务端（DB 层读它只为在服务端解析出封面）。
   *
   *  A3（2026-10-22）：移动端「回访作品带」需要封面图与产物节点 id ——
   *  用真实产物图做封面，辨识度远高于纯文字卡（默认封面在多个画布间完全相同，
   *  用户认不出哪个是自己做过的）。 */
  async list(userId: string) {
    const rows = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, createdAt: true, updatedAt: true, canvasData: true },
    })
    // 标题兜底：空标题按时间倒序编号（「画布 1 / 2 / 3」）——
    // 一排「未命名画布」等于没有识别线索，而识别线索是封面图之外唯一可认的东西。
    let untitledSeq = 0
    return rows.map((row) => {
      const cover = readCover(row.canvasData)
      const rawTitle = typeof row.title === 'string' ? row.title.trim() : ''
      const title = rawTitle || `画布 ${(untitledSeq += 1)}`
      return {
        id: row.id,
        title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        coverUrl: cover.coverUrl,
        coverNodeId: cover.coverNodeId,
      }
    })
  }

  async create(userId: string, title?: string) {
    return this.prisma.session.create({
      data: { userId, title: title ?? '未命名画布' },
    })
  }

  async update(id: string, userId: string, data: { title?: string; canvasData?: string }) {
    const session = await this.prisma.session.findFirst({ where: { id, userId } })
    if (!session) throw new NotFoundException('Session not found')
    return this.prisma.session.update({ where: { id }, data })
  }
}
