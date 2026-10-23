/**
 * 移动端 tap 意图路由（R2，D-C 状态机 empty 行）——单一真源。
 *
 * ⭐ 为什么需要它：R1 删掉移动端 Dock 后留下两个断点——
 *   ① `NodeRenderer.onTileOpen` 无条件开 viewer，而 viewer 的 img/video 均 `v-if="url"`
 *      ⇒ 空节点 tap 得到一片空白全屏；
 *   ② 音频空 src 走 `toggleAudio()`，播一个不存在的源，毫无反应。
 *   二者都应路由到编辑 sheet（「点击生成/撰写」主动作，D-C 的 empty 行）。
 *
 * 纯函数、零依赖：NodeRenderer / CanvasPage / MobileNodeTile 三处消费同一判据，
 * 不各写一遍（审阅焦点 #2）。
 */

/** viewer = 全屏查看器；editor = 编辑 sheet；inline = 磁贴内联处理（音频播放）。 */
export type MobileNodeTapIntent = 'viewer' | 'editor' | 'inline'

export function resolveMobileNodeTapIntent(node: {
  type: string
  data?: Record<string, unknown> | null
}): MobileNodeTapIntent {
  const data = node.data ?? {}
  if (node.type === 'audio') {
    return typeof data.url === 'string' && data.url ? 'inline' : 'editor'
  }
  if (node.type === 'text') {
    const content = data.content
    return typeof content === 'string' && content.trim() ? 'viewer' : 'editor'
  }
  const url = data.url
  return typeof url === 'string' && url ? 'viewer' : 'editor'
}
