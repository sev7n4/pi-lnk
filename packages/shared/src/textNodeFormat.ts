/**
 * 文本节点内容格式白名单 SSOT（规格 2026-10-28-text-node-html-artifact-design §4.4）。
 * 格式即属性（§4.1）：文本系新格式（svg/csv/json…）一律扩这里 + 前端渲染分支，
 * 禁止新增节点类型（NodeType 收敛纪律的延续）。
 * 写入侧 fail-closed（assert），读取侧 fail-soft（resolve）——严格写、宽容渲染（§4.2）。
 */
export const TEXT_NODE_FORMATS = ['plain', 'markdown', 'html'] as const
export type TextNodeFormat = (typeof TEXT_NODE_FORMATS)[number]

const FORMAT_SET: ReadonlySet<string> = new Set(TEXT_NODE_FORMATS)

/** 归一化：未知/缺省 ⇒ 'plain'。读取侧不抛错（渲染宽容）。 */
export function resolveTextNodeFormat(v: unknown): TextNodeFormat {
  return typeof v === 'string' && FORMAT_SET.has(v) ? (v as TextNodeFormat) : 'plain'
}

/** 写入侧白名单：非法值 throw，错误信息必须列出合法值（对齐 create_nodes_batch type 闸门文案模式）。 */
export function assertTextNodeFormat(v: unknown): asserts v is TextNodeFormat {
  if (typeof v !== 'string' || !FORMAT_SET.has(v)) {
    throw new Error(`invalid text node format "${String(v)}" (allowed: ${TEXT_NODE_FORMATS.join(', ')})`)
  }
}

/** 剥 HTML 标签为纯文本（节点卡摘要与移动端 TTS 朗读同源，规格 §8）。 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 节点卡摘要（§4.7/§8）：label > <title> > strip 首段，≤40 字符。 */
export function htmlNodeSummary(data: Record<string, unknown> | undefined): string {
  const label = typeof data?.label === 'string' ? data.label.trim() : ''
  if (label) return label.slice(0, 40)
  const content = typeof data?.content === 'string' ? data.content : ''
  if (!content.trim()) return ''
  const m = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = m ? m[1].replace(/\s+/g, ' ').trim() : ''
  const base = title || stripHtmlTags(content)
  return base.slice(0, 40)
}
