export interface SelectionDigestNode {
  type: string
  title: string
  x: number
  y: number
}

export interface SelectionDigestInput {
  nodeIds: readonly string[]
  /** 幂等；返回 undefined = 不属于本会话画布或已删除 ⇒ 剔除（同时承担归属校验） */
  lookup: (id: string) => SelectionDigestNode | undefined
  limit?: number
}

const DEFAULT_LIMIT = 8
const REST_ID_CAP = 16
const TAIL = '用户说「这个 / 这几个」时指的就是上面这些；要看细节调 get_node。'

/** 标题里的换行会破坏块的行结构（进而影响 classifyBlock 与截断），压平成空格。 */
function flattenTitle(raw: string): string {
  return raw.replace(/\s*\n+\s*/g, ' ').trim()
}

export function buildSelectionDigest(input: SelectionDigestInput): string | null {
  const limit = input.limit ?? DEFAULT_LIMIT
  const found: Array<SelectionDigestNode & { id: string }> = []
  for (const id of input.nodeIds) {
    const n = input.lookup(id)
    if (n) found.push({ id, ...n })
  }
  if (found.length === 0) return null

  found.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const total = found.length
  const lines = found.slice(0, limit).map((n) => `- ${n.id} · ${n.type} · ${flattenTitle(n.title)}`)
  const head = `【用户当前选中】${total} 个节点（${total === 1 ? '单选' : '框选'}）`
  if (total > limit) {
    const rest = found.slice(limit, limit + REST_ID_CAP).map((n) => n.id)
    const more = total - limit > rest.length ? ' …' : ''
    lines.push(`- （另 ${total - limit} 个：${rest.join('、')}${more}）`)
  }
  return [head, ...lines, TAIL].join('\n')
}
