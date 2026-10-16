/**
 * P1-4.1：回合产出收据行的文案模型（纯模块，便于单测）。
 *
 * 内容 EXACT（规格 P1-4.1）：
 * - summary = `本轮产出 N 张 · 定位到画布`（「定位到画布」由模板拆成按钮，复用既有 focus-all 事件）
 * - keepAll  = `全部保留`（= 当前行为，无操作确认态）
 * - undoTurn = `撤销本轮`（runtime 批量移除工具落地前 disabled，见 docs/adr/0010-agent-turn-undo-runtime-tool.md）
 */
export function buildTurnReceipt(input: { producedCount: number }) {
  return {
    summary: `本轮产出 ${input.producedCount} 张 · 定位到画布`,
    keepAll: '全部保留',
    undoTurn: '撤销本轮',
  }
}
