/**
 * SP-D 连线校验原语（ADR-0014）：框架无关纯函数，connectNodes / addNodesBatch /
 * 浏览器侧 connect-nodes 端点共同消费。确定性、无 IO（N7）；存量画布零迁移（N5）。
 *
 * 硬非法（missing-node / self-loop / cycle）由调用方 fail-closed 整批拒绝；
 * duplicate 仅为幂等跳过标记（N4：不报错、不产生第二条）。
 */
export interface RawEdge {
  source: string
  target: string
}

export type EdgeRejectReason = 'missing-node' | 'self-loop' | 'cycle' | 'duplicate'

export interface EdgeAdditionResult {
  /** 校验通过、待添加的边（id 沿用既有 `e-${source}-${target}` 规则，不改 N5） */
  valid: Array<{ id: string; source: string; target: string }>
  /** 未被添加的边及原因（duplicate 属幂等跳过，不是错误） */
  rejected: Array<{ edge: RawEdge; reason: EdgeRejectReason }>
}

/** 沿用既有确定性有向对 id 规则（与 agent-canvas-tools.service 的 edgeId 一致）。 */
export function edgeIdOf(source: string, target: string): string {
  return `e-${source}-${target}`
}

/**
 * 加入 source→target 是否会闭合环：从 target 沿既有有向边出发能否到达 source。
 * source===target 视为自环成环（N2）。
 * O(M) DFS（邻接表），单条边校验成本可控（spec §9-R3）。
 */
export function wouldCreateCycle(existingEdges: RawEdge[], source: string, target: string): boolean {
  if (source === target) return true
  const adj = new Map<string, string[]>()
  for (const e of existingEdges) {
    const list = adj.get(e.source)
    if (list) list.push(e.target)
    else adj.set(e.source, [e.target])
  }
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur === source) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) stack.push(next)
    }
  }
  return false
}

/**
 * 在已有 nodes/edges 上校验一批待加边（N1 端点存在 → N2 自环 → N4 去重 → N3 环）。
 * 纯函数：同输入同输出；批内互相成环（a→b 后 b→a）第二条按 cycle 拒绝；
 * 已接受边会累积进环检测基线，长环（a→b→c→a）同样可判。
 */
export function validateEdgeAdditions(
  nodes: Array<{ id: string }>,
  existingEdges: RawEdge[],
  newEdges: RawEdge[],
): EdgeAdditionResult {
  const nodeIds = new Set(nodes.map((n) => n.id))
  const seenPairs = new Set(existingEdges.map((e) => `${e.source}->${e.target}`))
  const accEdges: RawEdge[] = [...existingEdges]
  const valid: EdgeAdditionResult['valid'] = []
  const rejected: EdgeAdditionResult['rejected'] = []
  for (const edge of newEdges) {
    let reason: EdgeRejectReason | null = null
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) reason = 'missing-node'
    else if (edge.source === edge.target) reason = 'self-loop'
    else if (seenPairs.has(`${edge.source}->${edge.target}`)) reason = 'duplicate'
    else if (wouldCreateCycle(accEdges, edge.source, edge.target)) reason = 'cycle'
    if (reason) {
      rejected.push({ edge, reason })
    } else {
      valid.push({ id: edgeIdOf(edge.source, edge.target), source: edge.source, target: edge.target })
      seenPairs.add(`${edge.source}->${edge.target}`)
      accEdges.push(edge)
    }
  }
  return { valid, rejected }
}
