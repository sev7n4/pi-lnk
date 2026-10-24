/**
 * 画布封面抽取（服务端共用）。
 *
 * 2026-10-25 从 `canvas.service.ts` 抽出：列表接口（`GET /agent/canvas/list` 与
 * `GET /api/sessions`）都要「只回卡片元数据 + 封面 URL，不回整份 canvasData」——
 * 两侧必须同一套抽取口径，否则同一项目在抽屉里和主页卡片上会显示不同封面。
 *
 * ⭐ 为什么必须服务端算封面：全量返回 canvasData 时 165 个项目可达 2.3MB、
 * `/api/sessions` 实测 589KB。几百 KB 的传输中途若链路静默死亡（代理 / NAT 残留），
 * TCP 连接既不完成也不报错，Chrome 对单 host 的 6 条 HTTP/1.1 连接被这类僵尸占满
 * ⇒ 后续一切请求排队饿死（项目抽屉「项目加载中」转不完，2026-10-25 取证）。
 */

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

/** 从整份 canvasData 字符串里解析封面；任何异常都降级为「无封面」。 */
export function readCover(canvasData: string | null | undefined): CanvasCover {
  if (!canvasData) return { coverUrl: null, coverNodeId: null }
  try {
    const parsed = JSON.parse(canvasData) as { nodes?: unknown }
    const hit = pickLatestArtifact(parsed?.nodes)
    return hit ? { coverUrl: hit.url, coverNodeId: hit.nodeId } : { coverUrl: null, coverNodeId: null }
  } catch {
    return { coverUrl: null, coverNodeId: null }
  }
}
