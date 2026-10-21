/**
 * 画布标题的展示口径（2026-10-21 走查复盘轮）。
 *
 * 背景：主页「我的画布」曾把内部自动生成名（layout-smoke-1792588745 这类
 * 冒烟/测试 slug）直接当卡片标题渲染，UI 上看起来像调试面板泄漏。
 * 空标题与自动生成名一律显示「未命名画布」——用户真实命名原样保留。
 *
 * 判据只认两类「确定是机器生成的」形态：
 *   1. 名字里含独立词 smoke / e2e / test / tmp / temp（前后是非字母数字边界）；
 *   2. 以「-6 位以上数字」结尾（时间戳类后缀）。
 * 保守起见不碰其它形态——误把用户命名藏掉比显示 slug 更糟。
 */

/** 独立出现的自动化词（前后必须是非字母数字，防误伤 protest/latest 这类） */
const AUTO_WORD_RE = /(?:^|[^a-z0-9])(?:smoke|e2e|test|tmp|temp)(?:[^a-z0-9]|$)/i

/** 长数字时间戳后缀，如 -1792588745 / -1729528800000 */
const TRAILING_ID_RE = /-\d{6,}$/

export function displayCanvasTitle(title?: string | null): string {
  const t = (title ?? '').trim()
  if (!t) return '未命名画布'
  if (AUTO_WORD_RE.test(t) || TRAILING_ID_RE.test(t)) return '未命名画布'
  return t
}
