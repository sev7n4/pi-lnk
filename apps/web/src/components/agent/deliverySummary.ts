/**
 * E2-a 回合产物幽灵摘要 —— 派生纯函数（规格 docs/superpowers/specs/2026-11-04-e2a-ghost-delivery-summary-design.md §3）。
 *
 * D-a：只读消费 timeline parts，输出渲染期派生清单；同输入两次调用同输出；
 *      不 mutate 入参、不新增 part kind、不落 executionEvents——历史重放/快照重建结果一致。
 * D-b：N=0 由调用方整行隐藏（本模块以空数组表达）；failed / pending 不计入；
 *      计数文案 >9 收敛为「9+」。
 */
import { resolveTextNodeFormat, type TextNodeFormat } from '@lnkpi/shared'
import type { TimelinePart } from '@/components/agent/turnTimeline'

export interface DeliveryItem {
  nodeId: string
  nodeType: string
  title: string
  /** D5/D10（spec 2026-11-05-canvas-digest-design）：画布总览 tile 标记（tap 时追加 digest_open 打点）。 */
  digest?: true
  /**
   * 2026-11-06：文本系产物的内容格式（规格 #636 §4.4）。artifact part 本身不带
   * format，唯一真源是画布节点本体 data.format ⇒ 按 nodeId 从 canvasNodes 派生。
   * 仅在显式 html 时出现（plain/markdown 省略该字段，保持历史派生结果逐字不变），
   * ⛔ 禁止按内容嗅探推断（§4.2）。
   */
  format?: TextNodeFormat
}

/** 本回合可交付产物清单：done 且有 nodeId 的 artifact part，事件到达序保序。
 *  `canvasNodes`（2026-11-05 真机修复 Q2）：提供数组时过滤 nodeId 已不在画布的项
 *  （remove_node 不回写事件投影 ⇒ part 仍 done，必须按画布现况裁清单）；
 *  null/undefined = 未接线/未知态，不过滤（预览页保守显示）。
 *  P1a（2026-11-07）：**总览不再进本轮清单**。旧实现按当前全局画布给每一轮
 *  固定追加 digest tile ⇒ 零产物回合显示「有 1 个产物」、历史回合被注入当时还不存在
 *  的总览、撤销清单存在误删风险。现由 `canvasDigestEntry` 单独派生会话级入口，
 *  调用方只对最后一轮渲染（见 `digestEntryForTurn`）。
 */
export function turnDeliveryItems(
  parts: readonly TimelinePart[],
  canvasNodes?: readonly { id: string; data?: Record<string, unknown> | null }[] | null,
): DeliveryItem[] {
  const items: DeliveryItem[] = []
  for (const p of parts) {
    if (p.kind !== 'artifact' || p.status !== 'done') continue
    items.push({ nodeId: p.nodeId, nodeType: p.nodeType, title: p.title })
  }
  if (!canvasNodes) return items
  const byId = new Map(canvasNodes.map((n) => [n.id, n]))
  const alive = new Set(byId.keys())
  // 纯派生：文本系节点按 data.format 补出格式标签，供 tile 图标/小字区分
  // 「点开是阅读器还是沙箱预览」。未知/缺省 ⇒ resolve 为 plain ⇒ 不写字段。
  const filtered = items.map((it) => {
    // format 只属于文本系产物：图片/音视频节点的 data.format 是文件容器格式
    // （png/mp3/mp4 …），绝不能被当成 HTML 产物标签派生。
    if (it.nodeType !== 'text') return it
    const node = byId.get(it.nodeId)
    const format = resolveTextNodeFormat(node?.data?.format)
    return format === 'html' ? { ...it, format } : it
  }).filter((it) => alive.has(it.nodeId))
  return filtered
}

/** 系统「画布总览」节点（当前画布态投影）的会话级入口；节点已删则 null（S4）。 */
export function canvasDigestEntry(
  canvasNodes?: readonly { id: string; data?: Record<string, unknown> | null }[] | null,
): DeliveryItem | null {
  const digestNode = canvasNodes?.find((n) => n.data?.digest === true)
  if (!digestNode) return null
  return { nodeId: digestNode.id, nodeType: 'text', title: '画布总览', digest: true, format: 'html' }
}

/**
 * 历史回合不得注入总览（它当时还不存在，且总览始终指向**当前**画布态）。
 * 只有最后一轮才拿到会话级入口；纯函数便于行为级断言。
 */
export function digestEntryForTurn(
  entry: DeliveryItem | null | undefined,
  isLatestTurn: boolean,
): DeliveryItem | null {
  return isLatestTurn ? (entry ?? null) : null
}

/** 回合态判定（D-b）：存在 running artifact ⇒ 回合进行中，幽灵行不渲染。 */
export function hasRunningGeneration(parts: readonly TimelinePart[]): boolean {
  return parts.some((p) => p.kind === 'artifact' && p.status === 'running')
}

/** 计数文案（D-b）：0 → 空串；超过 9 收敛「9+」。 */
export function deliveryCountLabel(n: number): string {
  if (n <= 0) return ''
  if (n > 9) return '9+'
  return String(n)
}
