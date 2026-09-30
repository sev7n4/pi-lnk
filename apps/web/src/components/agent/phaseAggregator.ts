/** P1#4 阶段徽章：从 trace 步骤纯派生（不新增事件/状态；刷新后可从持久化 trace 恢复）。 */
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'

export type AgentPhase = 'exploring' | 'creating' | 'wrapping'

const WRITE_TOOLS = new Set([
  'upsert_prompt_node',
  'upsert_media_node',
  'set_node_text',
  'attach_refs',
  'propose_generation',
  'apply_sidebar_attachments',
  'apply_asset_to_node',
  'save_node_to_asset_library',
  'duplicate_node',
  'upload_media_to_canvas',
  'grid_slice_image',
  'connect_nodes',
  'introduce_nodes_to_agent',
])

/** 按时间序扫工具步，推导当前阶段；未知工具不推进（避免新工具打乱叙事）。 */
export function derivePhase(steps: ExecutionStep[]): AgentPhase | null {
  const toolSteps = steps.filter((s) => s.kind === 'tool')
  if (toolSteps.length === 0) return null
  let phase: AgentPhase = 'exploring'
  for (const s of toolSteps) {
    const name = s.meta?.toolName ?? ''
    if (name === 'cancel_generation') {
      phase = 'wrapping'
      continue
    }
    if (WRITE_TOOLS.has(name) || name.startsWith('run_')) phase = 'creating'
    // read 类与未知工具：保持当前阶段（exploring 起步）
  }
  return phase
}

export const PHASE_BADGE: Record<AgentPhase, { icon: string; label: string }> = {
  exploring: { icon: '🔍', label: '探索中' },
  creating: { icon: '🎨', label: '创作中' },
  wrapping: { icon: '📦', label: '收尾中' },
}
