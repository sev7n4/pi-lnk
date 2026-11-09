import type { CanvasAction, CanvasData } from './index'
import { isTerminalRegen } from './canvasLifecycle'

/**
 * 画布动作落地（Phase 5 收敛后的唯一 SSOT）。
 *
 * 此前 web `applyActionsToFlow`（`apps/web/src/composables/useCanvasActions.ts`）
 * 与 agent `applyCanvasActions`（`packages/agent/src/tools/executor.ts`）各写一套
 * 独立 switch，长期手动同步 → 行为漂移（见 SSE 统一规格 §8 / §13.1 #6）。本文件是
 * 收敛后的单一真相，两端薄适配器均委托此处，杜绝漂移。
 *
 * 规范化行为（收敛时统一两端的历史差异）：
 * - add_node：父节点存在 ⇒ 子节点置于 父.x+320 / 父.y+20；否则取 payload.position 或
 *   {200,200} 兜底；缺 id 的 action 直接跳过（非确定性兜底 id 会破坏双端一致，故统一要求 id）。
 * - add_edge：缺 id 时按 `e-${source}-${target}` 生成（保留 web 历史行为）；push 前
 *   按 id 查重，命中即跳过并经 `onSkipped('add_edge','duplicate_edge')` 留痕（带 id /
 *   无 id 重放均幂等）；source/target 缺失则跳过（保留 agent 的空值防御）。
 * - update_node / add_node 的 data 合并经 `mergeNodeData`（双守卫吸收态）。
 * - remove_edge / set_viewport / set_groups / set_composition_run_group：与历史 agent 行为一致。
 */
/** op 被跳过的原因（观测用，见 ApplyCanvasActionsOpts.onSkipped）。 */
export type CanvasActionSkipReason = 'duplicate_edge' | 'node_not_found'

export interface ApplyCanvasActionsOpts {
  /**
   * 吸收态守卫拒绝回调（规格 2026-11-04-generation-terminal-projection §5.2）：
   * update_node / add_node 试图把已终态（error/completed/failed）节点拉回在途态且未携带
   * 新 generationRecordId 时，该 op 的 data 合并被整体丢弃，经此回调留痕。
   */
  onGuardReject?: (nodeId: string) => void
  /** 观测专用：op 被跳过时留痕。不改变返回值，也不改变 op 的落地结果。 */
  onSkipped?: (type: string, reason: CanvasActionSkipReason, id: string) => void
}

/** add_node 缺父且无 position 时的兜底根坐标（收敛值，原 web 侧 {200,200}）。 */
const DEFAULT_ROOT_POSITION = { x: 200, y: 200 }
/** add_node 命中父节点时子节点的相对偏移（收敛值，原 web 侧 +320/+20）。 */
const PARENT_OFFSET = { dx: 320, dy: 20 }

/**
 * 节点 data 合并（双端单一来源）：吸收态守卫 + 阻塞 propose 的 stale pending_confirm。
 *
 * 历史两处独立实现（agent executor / web mergeNodeData）曾漂移，统一于此：
 * - 守卫 1（2026-10-01）：在途/终态节点被迟到 `pending_confirm` 覆盖 ⇒ 仅丢弃 status 字段，
 *   其余字段照常合并（避免「确认面 / 磁贴内容」回退）。
 * - 守卫 2（2026-11-04）：终态节点被无新 recordId 的在途态写回 ⇒ 整体丢弃 incoming
 *   （陈旧快照 / SSE 重放同族回灌的结构性阻断）。
 *
 * 二者互补，双端共用同一纯函数，任一守卫失效都会被下游契约测试捕获。
 */
const STALE_BLOCKED_STATUSES = new Set(['generating', 'completed', 'error', 'failed'])
const IN_TRANSIT_ONLY = new Set(['generating'])

export function mergeNodeData(
  existingData: Record<string, unknown> | undefined,
  incomingData: Record<string, unknown> | undefined,
  blockedStatuses: Set<string> = STALE_BLOCKED_STATUSES,
): Record<string, unknown> {
  const existingStatus = String(existingData?.status ?? '')
  const incomingStatus = String(incomingData?.status ?? '')
  // 守卫 1（2026-10-01）：stale pending_confirm 不得覆盖在途/终态节点——只丢 status，其余照并。
  let merged: Record<string, unknown> = { ...(existingData ?? {}), ...(incomingData ?? {}) }
  if (incomingStatus === 'pending_confirm' && blockedStatuses.has(existingStatus)) {
    if (existingData && 'status' in existingData) merged.status = existingStatus
    else delete merged.status
  }
  // 守卫 2（2026-11-04）：终态节点被无新 recordId 的在途态回写 ⇒ 整体丢弃 incoming。
  if (
    isTerminalRegen({
      currentStatus: existingStatus,
      currentRecordId: existingData?.generationRecordId,
      incomingStatus,
      incomingRecordId: incomingData?.generationRecordId,
    })
  ) {
    return { ...(existingData ?? {}) }
  }
  return merged
}

export function applyCanvasActions(
  data: CanvasData,
  actions: CanvasAction[],
  opts?: ApplyCanvasActionsOpts,
): CanvasData {
  const result: CanvasData = {
    ...data,
    nodes: [...data.nodes],
    edges: [...data.edges],
  }

  for (const action of actions) {
    switch (action.type) {
      case 'add_node': {
        const p = action.payload
        const parent = p.parentShotId
          ? result.nodes.find((n) => n.id === p.parentShotId)
          : null
        const pos = parent
          ? { x: parent.position.x + PARENT_OFFSET.dx, y: parent.position.y + PARENT_OFFSET.dy }
          : (p.position ?? { ...DEFAULT_ROOT_POSITION })
        // 收敛：统一要求 id（非确定性兜底 id 会破坏双端一致），缺 id 直接跳过。
        if (!p.id) break
        const existingIndex = result.nodes.findIndex((n) => n.id === p.id)
        if (existingIndex >= 0) {
          const existing = result.nodes[existingIndex]!
          // position 总是更新（即便守卫拒绝 data 合并，布局仍跟随父节点/载荷）。
          existing.position = pos
          if (
            isTerminalRegen({
              currentStatus: existing.data?.status,
              currentRecordId: existing.data?.generationRecordId,
              incomingStatus: p.data?.status,
              incomingRecordId: p.data?.generationRecordId,
            })
          ) {
            // 守卫拒绝 data 合并，留痕后跳过（position/type 已更新）。
            if (p.id) opts?.onGuardReject?.(p.id)
          } else {
            existing.data = mergeNodeData(existing.data, p.data)
          }
          if (p.nodeType) existing.type = p.nodeType as CanvasData['nodes'][0]['type']
        } else {
          result.nodes.push({
            id: p.id,
            // 2026-10-17 prompt 节点下线：兜底默认值 'prompt' → 'text'
            // （仅对导入 workflow 包缺 nodeType 的脏数据生效；新建路径均显式带类型）。
            type: (p.nodeType ?? 'text') as CanvasData['nodes'][0]['type'],
            position: pos,
            data: p.data ?? {},
          })
        }
        if (parent) {
          const edgeId = `e-${parent.id}-${p.id}`
          if (!result.edges.some((e) => e.id === edgeId)) {
            result.edges.push({ id: edgeId, source: parent.id, target: p.id })
          }
        }
        break
      }
      case 'update_node': {
        const node = result.nodes.find((n) => n.id === action.payload.id)
        if (!node) {
          opts?.onSkipped?.('update_node', 'node_not_found', String(action.payload.id ?? ''))
          break
        }
        if (action.payload.position) node.position = action.payload.position
        if (action.payload.data) {
          // 吸收态守卫（2026-11-04）：终态节点被无新 recordId 的在途态 op 回写
          // ⇒ 整体丢弃该 data 合并（陈旧快照回灌/迟到 op 在此被结构性阻断）。
          if (
            isTerminalRegen({
              currentStatus: node.data?.status,
              currentRecordId: node.data?.generationRecordId,
              incomingStatus: action.payload.data.status,
              incomingRecordId: action.payload.data.generationRecordId,
            })
          ) {
            if (action.payload.id) opts?.onGuardReject?.(action.payload.id)
          } else {
            node.data = mergeNodeData(node.data, action.payload.data, IN_TRANSIT_ONLY)
          }
        }
        break
      }
      case 'add_edge': {
        const { id, source, target } = action.payload
        // 收敛：缺 id 时按 source-target 生成（保留 web 历史行为）；push 前按 id 查重，
        // 命中即跳过并经 onSkipped 留痕（带 id / 无 id 重放均幂等）；source/target 缺失则跳过。
        const edgeId = id ?? (source && target ? `e-${source}-${target}` : undefined)
        if (!edgeId || !source || !target) break
        if (result.edges.some((e) => e.id === edgeId)) {
          opts?.onSkipped?.('add_edge', 'duplicate_edge', edgeId)
          break
        }
        result.edges.push({ id: edgeId, source, target })
        break
      }
      // 2026-09-29 补：此前 remove_edge / set_viewport 被静默忽略，导致
      // 「Nest 返回了 action、前端实时改了、但 canvasData 没落库」，
      // 回合末 loadSession() 全量回拉时被删的边会「复活」。
      case 'remove_edge': {
        const edgeId = action.payload.id
        if (!edgeId) break
        result.edges = result.edges.filter((e) => e.id !== edgeId)
        break
      }
      case 'set_viewport': {
        if (action.payload.viewport) result.viewport = action.payload.viewport
        break
      }
      // P1-C C2a：侧车 op（规格 2026-11-02 §4 收口前置）。此前侧车无 op 表达，
      // web canvasDiff 遇侧车变化只能回退整份 PUT。全量替换语义：
      // - set_groups：payload.groups 即终态（清空 = []，不删键——消费方 ?? [] 等价）；
      // - set_composition_run_group：null = 清除（落 undefined 删键）。
      case 'set_groups': {
        if (Array.isArray(action.payload.groups)) result.groups = action.payload.groups
        break
      }
      case 'set_composition_run_group': {
        const group = action.payload.compositionRunGroup
        if (group === null) {
          delete result.compositionRunGroup
        } else if (group) {
          result.compositionRunGroup = group
        }
        break
      }
      case 'remove_node':
        result.nodes = result.nodes.filter((n) => n.id !== action.payload.id)
        result.edges = result.edges.filter(
          (e) => e.source !== action.payload.id && e.target !== action.payload.id,
        )
        break
    }
  }

  return result
}
