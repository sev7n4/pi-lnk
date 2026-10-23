/**
 * P1-1.1：首屏通用样例 chips 的纯逻辑模块。
 *
 * 按「金句池维度」从语料池中选取 ≤4 条样例话术：
 * - empty     空画布（首屏默认）
 * - selection 画布有选中节点
 * - artifact  画布有已产出物
 * - attachment composer 已挂载素材（A1 新增）
 *
 * P1-1.2：buildDraftFromUtterance 只产出「可编辑草稿」——调用方（AgentSideRail
 * 的 fillFromUtterance）负责填充 + focus，绝不在该链路上 submit/send。
 */

export type CanvasPhase = 'empty' | 'selection' | 'artifact'

/**
 * 金句池维度 = 画布相 ∪ composer 状态。
 *
 * ⚠️ attachment **故意不并入 CanvasPhase**（2026-10-22 B′ 决策）：
 * CanvasPhase 描述的是「画布状态」，而「已上传/挂载素材」是 composer/草稿状态 ——
 * 两个维度。混进同一枚举后，再来「已选风格」「已写半句」就会组合爆炸。
 * 故由 pickUtteranceContext 显式裁决，CanvasPhase 三相保持不变。
 */
export type UtterancePhase = CanvasPhase | 'attachment'

export interface UtterancePool {
  empty: string[]
  selection: string[]
  artifact: string[]
  attachment: string[]
}

/** 每相最多展示 4 条（线框指南首屏 chips 上限）。 */
const MAX_CHIPS = 4

/**
 * 裁决当前该用哪个池。优先级：attachment > selection > artifact > empty。
 * hasAttachments 取自 `pendingAttachments.length > 0`（useSidebarAttachments），现成信号，零新增状态。
 */
export function pickUtteranceContext(input: {
  phase: CanvasPhase
  hasAttachments: boolean
}): UtterancePhase {
  if (input.hasAttachments) return 'attachment'
  return input.phase
}

/**
 * 取当前相的展示条目。
 *
 * @param rotation 起始偏移。池大于展示位时（如 empty 7 条 > 4 位）**必须轮换**，
 *   否则长尾永远排在第 5 位之后、一次都曝不了光 —— 等于没写。
 *   池小于展示位时只换序、**不补齐**（缺口不能靠重复填充掩盖）。
 */
export function selectExampleUtterances(
  phase: UtterancePhase,
  pool: UtterancePool,
  rotation = 0,
): string[] {
  const items = pool[phase] ?? []
  if (!items.length) return []
  const len = items.length
  const start = ((rotation % len) + len) % len
  const count = Math.min(MAX_CHIPS, len)
  const out: string[] = []
  for (let i = 0; i < count; i += 1) out.push(items[(start + i) % len])
  return out
}

export function buildDraftFromUtterance(text: string): string {
  return text
}
