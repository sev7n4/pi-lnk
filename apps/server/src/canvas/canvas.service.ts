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
/** create() 不传 title 时的默认落库值（IA v4 2026-10-23：项目=画布+对话，
 *  全仓文案收口到「项目」）。list 的标题兜底据此判定「未命名」——
 *  前端多处 create() 不传 title ⇒ 存储里恒是这个串（非空）⇒
 *  兜底只判空串会让编号永不触发（2026-10-23 真机走查实证：作品带里多条
 *  同名未命名不可分）。用户主动把标题改成同名串是病态用例，不区分。 */
const DEFAULT_PROJECT_TITLE = '未命名项目'
/** 历史默认落库值：IA v4 之前 create() 写的是「未命名画布」，存量项目标题恒为该串
 *  （2026-10-23 用户真机截图里那几条就是）。只认新默认值 ⇒ 存量项目永远显示旧名字、
 *  编号兜底对它们失效 ⇒ 未命名判定必须同时认这两个值。
 *  ⚠️ 精确匹配而非 includes：「未命名画布pro」一类「像而不是」的标题不受影响。 */
const LEGACY_DEFAULT_PROJECT_TITLE = '未命名画布'

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
    // 标题兜底：未命名（空串 / create() 默认落库值 / 历史默认落库值）按时间倒序
    // 编号（「项目 1 / 2 / 3」）——一排同名未命名等于没有识别线索，
    // 而识别线索是封面图之外唯一可认的东西。
    let untitledSeq = 0
    return rows.map((row) => {
      const cover = readCover(row.canvasData)
      const rawTitle = typeof row.title === 'string' ? row.title.trim() : ''
      const isUntitled =
        !rawTitle ||
        rawTitle === DEFAULT_PROJECT_TITLE ||
        rawTitle === LEGACY_DEFAULT_PROJECT_TITLE
      const title = isUntitled ? `项目 ${(untitledSeq += 1)}` : rawTitle
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
      data: { userId, title: title ?? DEFAULT_PROJECT_TITLE },
    })
  }

  async update(id: string, userId: string, data: { title?: string; canvasData?: string }) {
    const session = await this.prisma.session.findFirst({ where: { id, userId } })
    if (!session) throw new NotFoundException('Session not found')
    return this.prisma.session.update({ where: { id }, data })
  }
}
