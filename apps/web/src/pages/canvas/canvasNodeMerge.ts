/** Prefer server url/content/status over stale local empty values. */

export type MergeNode = {
  id: string
  type?: string
  data?: Record<string, unknown> | null
}

export function mergeCanvasNodesFromServer<T extends MergeNode>(
  local: T[],
  server: T[],
): T[] {
  const serverById = new Map(server.map((n) => [n.id, n]))
  const merged = local.map((ln) => {
    const sn = serverById.get(ln.id)
    if (!sn) return ln
    const ld = { ...(ln.data || {}) }
    const sd = sn.data || {}
    const sUrl = typeof sd.url === 'string' ? sd.url : ''
    const lUrl = typeof ld.url === 'string' ? ld.url : ''
    if (sUrl && (!lUrl || lUrl !== sUrl)) {
      ld.url = sUrl
      if (sd.status != null) ld.status = sd.status
      if (sd.generationRecordId != null) ld.generationRecordId = sd.generationRecordId
    }
    const sContent = typeof sd.content === 'string' ? sd.content.trim() : ''
    const lContent = typeof ld.content === 'string' ? ld.content.trim() : ''
    if (sContent && sContent !== lContent) {
      ld.content = sd.content
      if (sd.status != null) ld.status = sd.status
    }
    if (!sUrl && sd.status === 'generating') {
      ld.status = 'generating'
      if (sd.generationRecordId != null) ld.generationRecordId = sd.generationRecordId
      if (typeof sd.generationStartedAt === 'string' && sd.generationStartedAt) {
        ld.generationStartedAt = sd.generationStartedAt
      }
    }
    return { ...ln, data: ld }
  })
  // Append server-only nodes (e.g. new split skeletons)
  const localIds = new Set(local.map((n) => n.id))
  for (const sn of server) {
    if (!localIds.has(sn.id)) merged.push(sn)
  }
  return merged
}

/**
 * 2026-10-01 修：按 id 收敛节点数组，用于让**存量**重复节点自愈。
 *
 * 保留「首条」而非末条：重复产生后 update_node 只命中首条（applier 用 find 取首个
 * 匹配），因此首条才带着最新的 url/content/prompt，末条是无更新的原始副本。
 */
export function dedupeNodesById<T extends MergeNode>(nodes: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const n of nodes) {
    if (seen.has(n.id)) continue
    seen.add(n.id)
    out.push(n)
  }
  return out
}
