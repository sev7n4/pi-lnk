/**
 * 移动端 tap 意图路由（R2，D-C 状态机 empty 行）——单一真源。
 *
 * ⭐ 为什么需要它：R1 删掉移动端 Dock 后留下两个断点——
 *   ① `NodeRenderer.onTileOpen` 无条件开 viewer，而 viewer 的 img/video 均 `v-if="url"`
 *      ⇒ 空节点 tap 得到一片空白全屏；
 *   ② 音频空 src 走 `toggleAudio()`，播一个不存在的源，毫无反应。
 *   二者都应路由到编辑 sheet（「点击生成/撰写」主动作，D-C 的 empty 行）。
 *   ⚠️ 2026-10-25（D1/D3）：上一条结论已被**状态门控**取代——产品铁律 P1
 *      「单击 = 查看」：空 / 生成中 / 失败无旧产物 ⇒ 无 op + 轻提示（引导长按），
 *      单击不再进编辑器；管理与撰写只走长按。判据见下方 `resolveMobileNodeTapIntent`。
 *
 * 纯函数、零依赖：NodeRenderer / CanvasPage / MobileNodeTile 三处消费同一判据，
 * 不各写一遍（审阅焦点 #2）。
 */

import { resolveMobileNodeState } from '@/composables/mobileNodeState'

/**
 * viewer = 全屏查看器；editor = 编辑 sheet；
 * none = 无 op + 轻提示（引导长按）。
 *
 * ⭐ 状态门控（2026-10-25 规格 §5.1，缺陷 D1/D3）：本函数此前只看 type+data，
 * 把「空节点」路由到 editor ⇒ 用户单击就进编辑器，违背 P1「单击 = 查看」。
 * 判据顺序（**不可交换**）：
 *   1) 状态优先：generating → none；error 且无旧产物 → none
 *   2) 有产物（pending / confirmed / error+旧产物）→ viewer
 *   3) 其余（empty）→ none
 *
 * ⚠️ 2026-10-27（D2 修订，真机走查④）：音频不再早退 'inline'——音频与其他
 *    类型走同一状态门控（有产物 → 波形查看器）。原「音频永不进查看器」与
 *    §4.3 音频标注承诺矛盾；磁贴内联播放保留（走播放按钮，非 tap）。
 */
export type MobileNodeTapIntent = 'viewer' | 'editor' | 'none'

export function resolveMobileNodeTapIntent(node: {
  type: string
  data?: Record<string, unknown> | null
}): MobileNodeTapIntent {
  const data = node.data ?? {}

  const state = resolveMobileNodeState({ type: node.type, data })

  // 生成中：壳层状态栏已给「耗时 · 取消」，tap 不重复入口
  if (state === 'generating') return 'none'

  // 失败且无旧产物：无内容可看 ⇒ 无 op + 引导
  if (state === 'error') {
    const hasOld = node.type === 'text'
      ? Boolean(String(data.content ?? '').trim())
      : Boolean(String(data.url ?? '').trim())
    return hasOld ? 'viewer' : 'none'
  }

  // pending / confirmed：先看产出
  if (state === 'pending' || state === 'confirmed') return 'viewer'

  // empty：无产物 ⇒ 无 op + 轻提示「长按编辑 / 长按撰写」
  return 'none'
}
