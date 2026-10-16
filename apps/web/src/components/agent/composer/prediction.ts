/**
 * P2-1.1 composer 输入预测（纯函数）：ghost 灰字建议 + Tab 接受。
 * 最小实现：历史中找以 draft 开头的条目，返回其剩余部分；无命中 → null。
 */
export function acceptPrediction(draft: string, ghost: string): string {
  return draft + ghost
}

export function buildGhostPrediction(input: { draft: string; history: string[]; refs: string[] }): string | null {
  if (!input.draft || input.history.length === 0) return null
  const hit = input.history.find((h) => h.startsWith(input.draft) && h.length > input.draft.length)
  return hit ? hit.slice(input.draft.length) : null
}
