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
/** 标题上限：digest 与画布摘要共享动态预算（classifyBlock → canvas），超长标题会挤掉摘要份额。 */
const TITLE_CAP = 80
const TAIL = '用户说「这个 / 这几个」时指的就是上面这些；要看细节调 get_node。'

/** 标题里的换行会破坏块的行结构（进而影响 classifyBlock 与截断），压平成空格。 */
function flattenTitle(raw: string): string {
  return raw.replace(/\s*\n+\s*/g, ' ').trim()
}

/** 截断到 TITLE_CAP（按字符，避免代理对被切半）。 */
function capTitle(flat: string): string {
  if (flat.length <= TITLE_CAP) return flat
  return `${flat.slice(0, TITLE_CAP)}…`
}

export function buildSelectionDigest(input: SelectionDigestInput): string | null {
  // `limit<=0` 会让 `lines` 为空而 head 仍写「共 N 个」⇒ 自相矛盾；
  // 负数更糟：`slice(-5, 11)` 从尾部切，甚至让「另 N 个」的 N 变成假数。
  // 一律夹到最小可用值 1（head 说有 N 个，就必须列得出至少 1 行）。
  const rawLimit = input.limit ?? DEFAULT_LIMIT
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : DEFAULT_LIMIT
  const found: Array<SelectionDigestNode & { id: string }> = []
  const seen = new Set<string>()
  for (const id of input.nodeIds) {
    // 去重：同一 id 重复出现会让 head 的「共 N 个」虚高、同一行被列两次
    // （框选拖拽 + 客户端追加是现实来源，不防御就会出现自相矛盾的块）。
    if (seen.has(id)) continue
    seen.add(id)
    const n = input.lookup(id)
    if (n) found.push({ id, ...n })
  }
  if (found.length === 0) return null

  found.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const total = found.length
  const lines = found
    .slice(0, limit)
    .map((n) => `- ${n.id} · ${n.type} · ${capTitle(flattenTitle(n.title))}`)
  const head = `【用户当前选中】${total} 个节点（${total === 1 ? '单选' : '框选'}）`
  if (total > limit) {
    const rest = found.slice(limit, limit + REST_ID_CAP).map((n) => n.id)
    const more = total - limit > rest.length ? ' …' : ''
    lines.push(`- （另 ${total - limit} 个：${rest.join('、')}${more}）`)
  }
  return [head, ...lines, TAIL].join('\n')
}
