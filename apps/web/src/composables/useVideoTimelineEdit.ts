import { api } from '@/services/api'
import type { TimelineOp, VideoTimeline } from '@lnkpi/shared'

export interface TimelineEditSubmit {
  sessionId: string
  nodeId: string
  ops: TimelineOp[]
}

export interface TimelineEditResult {
  ok: boolean
  timeline?: VideoTimeline
  error?: string
  visualDurationSec?: number
}

/**
 * P1.2 双通道前端写回：把浮层/手工编辑产生的 ops 提交到浏览器 edit 端点，
 * 与 agent 工具走同一份 service.edit()/共享 reducer/事务写治理。
 *
 * 关键纪律：提交成功后不信任本地预览，一律 GET 服务端 session 回读最新 canvasData
 * 中该节点 timeline 作为真相源（GET 带 no-store，避免拿到缓存的旧画布）。
 */
/** 可作为时间线素材的画布节点（喂给共享 reducer 的 ctx.sources 做真实节点校验）。 */
export interface TimelineSource {
  nodeId: string
  type: string
  title?: string
  url?: string
}

/**
 * P2.5：拉当前 session 画布节点作为时间线素材源（+音频/add_* 的硬前置）。
 * 复用与 submitTimelineOps 相同的 GET session + no-store 读通道，服务端真相源，不信任本地预览。
 */
export async function fetchTimelineSources(sessionId: string): Promise<TimelineSource[]> {
  if (!sessionId) return []
  try {
    const get = await api.get(`/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    })
    const envelope = get.data as { data?: { canvasData?: string | Record<string, unknown> } }
    let canvas = envelope?.data?.canvasData
    if (typeof canvas === 'string') {
      try { canvas = JSON.parse(canvas) as Record<string, unknown> } catch { return [] }
    }
    const nodes = (canvas as { nodes?: Array<{ id: string; type?: string; data?: Record<string, unknown> }> } | undefined)?.nodes
    if (!Array.isArray(nodes)) return []
    return nodes
      .filter((n) => ['video', 'image', 'audio'].includes(String(n.type ?? n.data?.type ?? '')))
      .map((n) => ({
        nodeId: n.id,
        type: String(n.type ?? n.data?.type ?? ''),
        title: typeof n.data?.label === 'string' ? n.data.label : undefined,
        url: String(n.data?.url ?? ''),
      }))
      .filter((s) => s.url) // 无 url 的节点不能作为裁剪/混音素材，绝不喂给 reducer
  } catch {
    return [] // 读失败 ⇒ 空 sources ⇒ add_* 会被 reducer 以 unknown_source_node 拒绝，绝不裸 URL 注入
  }
}

export async function submitTimelineOps(input: TimelineEditSubmit): Promise<TimelineEditResult> {
  if (!input.sessionId || !input.nodeId) return { ok: false, error: 'invalid_input' }
  if (!Array.isArray(input.ops)) return { ok: false, error: 'invalid_ops' }
  try {
    const post = await api.post('/video-timeline/edit', {
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      ops: input.ops,
    })
    const body = post.data as { ok?: boolean; error?: string; data?: Record<string, unknown> }
    if (!body?.ok) return { ok: false, error: body?.error ?? 'edit_rejected' }

    // 服务端回读为准（no-store）：解析 canvasData.nodes 找到目标节点的最新 timeline。
    const get = await api.get(`/sessions/${encodeURIComponent(input.sessionId)}`, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    })
    const envelope = get.data as { data?: { canvasData?: string | Record<string, unknown> } }
    let canvas = envelope?.data?.canvasData
    if (typeof canvas === 'string') {
      try { canvas = JSON.parse(canvas) as Record<string, unknown> } catch { return { ok: false, error: 'invalid_canvas' } }
    }
    const nodes = (canvas as { nodes?: Array<{ id: string; data?: Record<string, unknown> }> } | undefined)?.nodes
    const node = Array.isArray(nodes) ? nodes.find((n) => n.id === input.nodeId) : undefined
    const timeline = node?.data?.timeline as VideoTimeline | undefined
    if (!timeline) return { ok: false, error: 'timeline_not_found_after_write' }
    return {
      ok: true,
      timeline,
      visualDurationSec: Number((body.data as { visualDurationSec?: number } | undefined)?.visualDurationSec ?? 0),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'edit_failed'
    return { ok: false, error: message }
  }
}
