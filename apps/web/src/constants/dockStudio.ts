/** Dock Studio 可编辑节点类型与策略（Sprint A / P0-6） */

export const EDITABLE_NODE_TYPES = new Set([
  'text',
  'image',
  'video',
  'audio',
  'sceneComposer',
  'shot',
  // 被删历史（2026-10-17 prompt 节点下线）：'prompt' 曾在本集合中
  // （存量 prompt 节点随之退出 Dock 编辑入口，卡片只读——Phase 3 冻结）。
  'mediaInput',
  'videoComposition',
])

/** 使用独立 Dock Panel 的节点 */
export const DOCK_PANEL_NODE_TYPES = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  shot: 'shot',
  mediaInput: 'mediaInput',
  sceneComposer: 'sceneComposer',
  videoComposition: 'videoComposition',
} as const

export type DockPanelNodeType = keyof typeof DOCK_PANEL_NODE_TYPES

export function isDockPanelNodeType(type: string): type is DockPanelNodeType {
  return type in DOCK_PANEL_NODE_TYPES
}

/** 节点生成状态机（P0-4） */
export const NODE_GENERATION_STATUS = {
  draft: 'draft',
  generating: 'generating',
  completed: 'completed',
  error: 'error',
  failed: 'failed',
  fallback_pending: 'fallback_pending',
} as const

export type NodeGenerationStatus = (typeof NODE_GENERATION_STATUS)[keyof typeof NODE_GENERATION_STATUS]

export function isNodeGenerating(status: unknown): boolean {
  return (
    status === NODE_GENERATION_STATUS.generating ||
    status === NODE_GENERATION_STATUS.fallback_pending
  )
}

/** Dock 生成按钮「停止方块」态：仅真正生成中（不含 fallback_pending）。 */
export function isDockGenerateBusy(status: unknown): boolean {
  return status === NODE_GENERATION_STATUS.generating
}

/**
 * ADR-0011（2026-10-19）：propose 待确认阻塞态。它**不在** NODE_GENERATION_STATUS
 * 枚举里——不是生成态，而是「agent 已提议、等待用户在画布节点上确认/取消」的阻塞态
 * （由 propose 流程经 update_node 写入，见 proposeWaitActions.ts）。
 */
export const NODE_PENDING_CONFIRM_STATUS = 'pending_confirm'

/**
 * ADR-0011 T4：节点是否处于待确认态（dock 门控 / 节点内联确认面的唯一判据）。
 *
 * 收敛前该判据内联散落于 CanvasPage（countPendingInSelection /
 * handleSelectionBatchBlocked / mobileStudioDockOpen 门控意图）——单表面原则要求
 * 「谁是 pending_confirm」全局同一答案，故收口为函数。宽松入参类型同时兼容
 * EditableFlowNode / FlowNode / { data } 字面量。
 */
export function isPendingConfirmNode(
  node: { data?: { status?: unknown } | undefined } | null | undefined,
): boolean {
  if (!node) return false
  return String(node.data?.status ?? '') === NODE_PENDING_CONFIRM_STATUS
}
