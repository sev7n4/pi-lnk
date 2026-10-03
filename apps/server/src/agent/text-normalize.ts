/**
 * 助手消息文本归一化（生产取证：12224 条消息里 177 条 / 1.4% 的 content 开头挂着
 * 1~13 个连续换行；根因在上游 harness 分段或 agnes 网关在 thinking↔content 边界补 \n）。
 *
 * 边界纪律：
 * - **只动首尾纯空白行，绝不碰正文内部**——markdown 段落间隔、列表、代码块缩进都是正文结构。
 * - 只在**落库前**调用一次，不逐帧 normalize text_delta：流式期间每个 delta 单独切头会把
 *   跨 delta 的段落换行吃掉（delta1 "……段一" + delta2 "\n\n段二" 会退化成黏连的一段）。
 *
 * 对齐既有 planMarkers.ts/stripPlanMarkers 的风格：纯函数、无 IO、可单测。
 */

/** 开头的空行：奇数行是纯空白（空格/制表/全角空格）+ 换行 */
const LEADING_BLANK_LINES = /^([ \t\u3000]*\r?\n)+/
/** 结尾的空白与空行行 */
const TRAILING_BLANK = /[ \t\u3000]*(\r?\n[ \t\u3000]*)*$/

/**
 * 归一化助手文本：剥离开头连续空行、去掉结尾空行/行尾空白，正文逐字节保留。
 * 空串与纯空白一律归一化为空串——调用方 finalizeTurn 直接落这个值，**不做兜底**。
 */
export function normalizeAssistantText(raw: string): string {
  if (!raw) return raw
  const strippedLeading = raw.replace(LEADING_BLANK_LINES, '')
  if (!strippedLeading) return ''
  return strippedLeading.replace(TRAILING_BLANK, '')
}
