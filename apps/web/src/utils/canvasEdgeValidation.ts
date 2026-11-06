import type { Connection, Edge } from '@vue-flow/core'

/**
 * SP-D（ADR-0014）连线校验的**单一真源**。
 *
 * 前端只做「确定非法」的廉价拦截：自环 + 本地已存在的同向对（拖线时即时反馈）。
 * 环检测以服务端为权威，前端不做实时判环（前端不知远端完整图）。
 *
 * ⭐ 2026-11-06 双端零连线根因修复：VueFlow 1.48 把 `:is-valid-connection`
 * 同步进 `state.isValidConnection`，并在 `setEdges()` → `createGraphEdges()`
 * 里对**批量加载的每一条已有边**也调用它。若这里只做「同向对已存在 ⇒ false」，
 * 加载会话时每条边都能在 `existingEdges` 里匹配到自己，被判 `EDGE_INVALID`
 * 全量丢弃 ⇒ `.vue-flow__edge-path` 为 0（PC/移动端共用同一 `<VueFlow>`）。
 *
 * 判据按**对象形态**区分两条语义不同的调用路径（读 1.48 源码坐实）：
 *  · 回放 `setEdges/addEdges/updateEdge` → `createGraphEdges()` 收的是 `Edge`，
 *    `isEdge()` 的判据就是对象上存在 `id` 键（值可以是 undefined）。
 *  · 拖拽 `useHandle` → `isValidHandle()` 现造的 `Connection` 只有四个端点字段，
 *    对象上没有 `id` 键。
 * 回放 = 把已落库的边重新交给 VueFlow，不是新建连接 ⇒ 必须放行；只有拖拽
 * 才做重复拦截（即时反馈）。⛔ 不要改回「按 id 值去本地边集匹配」：历史数据
 * 若 id 缺失/为空会再次全量丢弃（生产 1478 条边已核实 0 缺失，但仍不把正确性
 * 押在数据质量上）。
 */
export function isValidCanvasConnection(
  connection: Connection | Edge | null,
  existingEdges: readonly { id: string; source: string; target: string }[],
): boolean {
  if (!connection?.source || !connection.target) return false
  if (connection.source === connection.target) return false

  // `Edge` 回放：本地重复判据不适用，放行（否则每条边被自己判重而丢弃）。
  if ('id' in connection) return true

  // 拖拽中的 `Connection`：廉价本地拦截（自环已在上面拦掉）。
  return !existingEdges.some(
    (e) => e.source === connection.source && e.target === connection.target,
  )
}
