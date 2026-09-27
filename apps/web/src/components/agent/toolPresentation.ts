/**
 * P1 工具展示注册表（设计 §2 第 2 层）：执行过程步骤 → 图标 + 人话短语。
 * 纯映射表 + 纯函数，不进事件契约（D2）；未知工具兜底 ⚙ 调用 {name}。
 */

export interface ToolPresentation {
  icon: string
  verb: string
}

/** 注册表：精确名命中 > run_ 前缀 > 兜底（设计 §2 表格逐条落）。 */
export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  load_skill: { icon: '⚡', verb: '加载技能' },
  get_canvas_summary: { icon: '🔍', verb: '感知画布' },
  upsert_media_node: { icon: '✏️', verb: '创建节点' },
  propose_generation: { icon: '🖼️', verb: '提议生成' },
  cancel_generation: { icon: '⏹', verb: '取消生成' },
}

const RUN_PREFIX_ICON = '🎨'
const FALLBACK_ICON = '⚙'
/** 思考步图标：thinking 不是工具调用，独立图标避免落进 ⚙「调用 xxx」兜底语义。 */
const THINKING_ICON = '🧠'

/** P1 时间线默认折叠（v1 不做用户偏好持久化）。 */
export const collapsedDefault = true

/** 从 label 解析 args（reducer 只把 args 写进 label「调用 {name} · {args}」，meta.args 未持久化）。 */
function argsFromLabel(toolName: string, label: string): string | undefined {
  const prefix = `调用 ${toolName} · `
  return label.startsWith(prefix) ? label.slice(prefix.length) : undefined
}

/** 步骤 → { icon, label }：icon/动词查注册表，args 取 meta.args 优先、label 后缀兜底。 */
export function presentToolStep(step: {
  label: string
  kind?: string
  meta?: { toolName?: string; args?: string }
}): { icon: string; label: string } {
  // thinking 步（模型思考流）不走工具注册表：直接保留原 label，图标用 🧠
  if (step.kind === 'thinking') return { icon: THINKING_ICON, label: step.label || '思考中…' }
  const name = step.meta?.toolName ?? ''
  if (!name) return { icon: FALLBACK_ICON, label: step.label || '执行步骤' }
  const hit = TOOL_PRESENTATION[name]
  if (!hit) {
    // run_ 前缀（生成类）→ 🎨；其余兜底 ⚙ 调用 {name}
    if (name.startsWith('run_')) return { icon: RUN_PREFIX_ICON, label: `生成 · ${name.slice(4)}` }
    return { icon: FALLBACK_ICON, label: `调用 ${name}` }
  }
  const args = step.meta?.args ?? argsFromLabel(name, step.label)
  return { icon: hit.icon, label: args ? `${hit.verb} · ${args}` : hit.verb }
}

/** 折叠头行：「N 步 · 最新：<icon> <label>」（phase 不计——它是门控提示，不是操作步）。 */
export function timelineHeadline(trace: {
  steps: Array<{ kind: string; label: string; meta?: { toolName?: string; args?: string } }>
}): string {
  const visible = trace.steps.filter((s) => s.kind !== 'phase')
  const last = visible[visible.length - 1]
  if (!last || visible.length === 0) return '0 步'
  const shown = presentToolStep(last)
  return `${visible.length} 步 · 最新：${shown.icon} ${shown.label}`
}
