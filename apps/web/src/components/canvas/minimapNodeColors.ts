/** 小地图节点配色（单源）：PC CanvasBottomLeftControls 与移动端 MobileCanvasTopControls 共用。
 *  2026-10-19 抽出——theme-usage 棘轮控 inline-rgba 只减不增，两份内联必增计数。 */
export const MINIMAP_NODE_COLORS: Record<string, string> = {
  text: 'rgba(125, 211, 252, 0.75)',
  image: 'rgba(110, 231, 183, 0.75)',
  video: 'rgba(167, 139, 250, 0.75)',
  audio: 'rgba(34, 211, 238, 0.75)',
  shot: 'rgba(129, 140, 248, 0.8)',
  group: 'rgba(192, 132, 252, 0.5)',
  prompt: 'rgba(129, 140, 248, 0.55)',
}

export function miniMapNodeColor(node: { type?: string }) {
  return MINIMAP_NODE_COLORS[String(node.type ?? '')] ?? 'rgb(var(--lnk-overlay-rgb) / 0.35)'
}
