/** P1#3 工具卡合并：≥minRun 次连续同名调用合并为一张计数卡；低频调用保持独立（避免被藏）。 */
export interface CollapsedToolCall {
  name: string
  argsSummary?: string
  result?: unknown
  count: number
}

export function collapseToolCalls(
  calls: Array<{ name: string; argsSummary?: string; result?: unknown }>,
  minRun = 3,
): CollapsedToolCall[] {
  const out: CollapsedToolCall[] = []
  let i = 0
  while (i < calls.length) {
    let j = i
    while (j + 1 < calls.length && calls[j + 1].name === calls[i].name) j++
    const runLen = j - i + 1
    if (runLen >= minRun) {
      out.push({ name: calls[i].name, count: runLen, result: calls[j].result })
      i = j + 1
    } else {
      for (let k = i; k <= j; k++) {
        out.push({
          name: calls[k].name,
          argsSummary: calls[k].argsSummary,
          result: calls[k].result,
          count: 1,
        })
      }
      i = j + 1
    }
  }
  return out
}
