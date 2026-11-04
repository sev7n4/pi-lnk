import type { CanvasAction, CanvasData } from '@lnkpi/shared'
import { isTerminalRegen } from '@lnkpi/shared'

export interface ApplyCanvasActionsOpts {
  /**
   * 吸收态守卫拒绝回调（规格 2026-11-04-generation-terminal-projection §5.2）：
   * update_node 试图把已终态（error/completed/failed）节点拉回在途态且未携带
   * 新 generationRecordId 时，该 op 的 data 合并被整体丢弃，经此回调留痕。
   */
  onGuardReject?: (nodeId: string) => void
}

/** Apply agent canvas mutations to an in-memory canvas snapshot. */
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
        const parentShot = p.parentShotId
          ? result.nodes.find((n) => n.id === p.parentShotId)
          : null
        const pos = parentShot
          ? { x: parentShot.position.x + 280, y: parentShot.position.y }
          : (p.position ?? { x: 0, y: 0 })
        if (!p.id) break
        // 2026-10-01 修：add_node 必须幂等。同一条 action 被 apply 两次（SSE 重放 /
        // 前端整份覆盖保存）时，旧实现会 push 出第二条同 id 节点，且 update_node
        // 只命中首条 → 两条内容分化（生产 30/253 画布命中）。
        const existingIndex = result.nodes.findIndex((n) => n.id === p.id)
        if (existingIndex >= 0) {
          const existing = result.nodes[existingIndex]!
          existing.position = pos
          // 吸收态守卫同款（与 update_node 一致）：重放的 add_node 不得把终态节点
          // 拉回在途态（SSE 重放是 2026-11-04 事故的同族回灌向量）。
          if (
            !isTerminalRegen({
              currentStatus: existing.data?.status,
              currentRecordId: existing.data?.generationRecordId,
              incomingStatus: p.data?.status,
              incomingRecordId: p.data?.generationRecordId,
            })
          ) {
            existing.data = { ...existing.data, ...(p.data ?? {}) }
          } else {
            if (p.id) opts?.onGuardReject?.(p.id)
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
        if (parentShot) {
          const edgeId = `e-${parentShot.id}-${p.id}`
          if (!result.edges.some((e) => e.id === edgeId)) {
            result.edges.push({ id: edgeId, source: parentShot.id, target: p.id })
          }
        }
        break
      }
      case 'update_node': {
        const node = result.nodes.find((n) => n.id === action.payload.id)
        if (node) {
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
              break
            }
            node.data = { ...node.data, ...action.payload.data }
          }
        }
        break
      }
      case 'add_edge': {
        const { id, source, target } = action.payload
        if (!id || !source || !target) break
        result.edges.push({ id, source, target })
        break
      }
      // 2026-09-29 补：此前 remove_edge / set_viewport 被静默忽略，导致
      // 「Nest 返回了 action、前端实时改了、但 canvasData 没落库」，
      // 回合末 loadSession() 全量回拉时被删的边会复活。
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
