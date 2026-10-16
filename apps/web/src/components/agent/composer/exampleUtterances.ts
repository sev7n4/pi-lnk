/**
 * P1-1.1：首屏通用样例 chips 的纯逻辑模块。
 *
 * 按画布相（CanvasPhase）从语料池中选取 ≤4 条样例话术：
 * - empty     空画布（首屏默认）
 * - selection 画布有选中节点
 * - artifact  画布有已产出物
 *
 * P1-1.2：buildDraftFromUtterance 只产出「可编辑草稿」——调用方（AgentSideRail
 * 的 fillFromUtterance）负责填充 + focus，绝不在该链路上 submit/send。
 */

export type CanvasPhase = 'empty' | 'selection' | 'artifact'

export interface UtterancePool {
  empty: string[]
  selection: string[]
  artifact: string[]
}

/** 每相最多展示 4 条（线框指南首屏 chips 上限）。 */
const MAX_CHIPS = 4

export function selectExampleUtterances(phase: CanvasPhase, pool: UtterancePool): string[] {
  return (pool[phase] ?? []).slice(0, MAX_CHIPS)
}

export function buildDraftFromUtterance(text: string): string {
  return text
}
