/** P1#5 todo 面板：agent 文本内联计划标记（prompt 约定）解析。
 * 标记必须独占一行；strip 后标记行替换为空行，其余内容字节级不动。 */
const PLAN_RE = /^⟦plan⟧(.+)$/gm
const DONE_RE = /^⟦task-done⟧(\d+)$/gm

export interface PlanItem {
  n: number
  title: string
}

export function stripPlanMarkers(text: string): {
  text: string
  plan?: PlanItem[]
  doneN?: number
} {
  let plan: PlanItem[] | undefined
  let doneN: number | undefined
  const out = text.replace(PLAN_RE, (_m, body: string) => {
    try {
      const parsed = JSON.parse(body) as unknown
      if (
        Array.isArray(parsed)
        && parsed.every(
          (it) =>
            !!it
            && typeof it === 'object'
            && typeof (it as { n?: unknown }).n === 'number'
            && typeof (it as { title?: unknown }).title === 'string',
        )
      ) {
        plan = parsed as PlanItem[]
        return ''
      }
    } catch {
      // malformed → 仍剥离
    }
    return ''
  })
  const out2 = out.replace(DONE_RE, (_m, n: string) => {
    doneN = Number(n)
    return ''
  })
  return { text: out2, plan, doneN }
}
