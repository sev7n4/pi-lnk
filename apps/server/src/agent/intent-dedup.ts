/**
 * P4 意图级去重（根治规格 2026-11-01-red-car-disconnect-misreport-duplicate-rootfix §8.3 / §9-P4）。
 *
 * 根因：生产会话 cmvwkh89b00lgp801xu2fjbrr 断线被误报「生成失败」→ 用户重发同句
 * → 新 operation → 重复生成 2 张红车（② 双图）。P0 已消除「误报诱导」这一触发路径；
 * P4 在 Nest 入口对「同 thread + 同归一化意图 + 近窗」做意图级去重，作为兜底：
 * 即便用户手抖连点同句，也至多产 1 张图。
 *
 * 设计边界（对照规格 §11 R3 误杀风险）：
 *  - 归一化只做确定性、保守的归一（空白/标点/大小写/截断），**不**做语义相似——
 *    越保守越不会误杀「真想再生成一张」的请求。
 *  - 含再生成语义词（再/第二/另一个/换一张…）的请求直接放行（isRegenerationIntent）。
 *  - 近窗默认 60s：误报重发发生在断流后秒级，60s 足够覆盖；超时放行避免误杀。
 */

/** 意图去重近窗（ms）。与规格 §11 R3 一致。 */
export const INTENT_DEDUP_WINDOW_MS = 60_000

/**
 * 归一化用户意图为稳定指纹。
 * 处理：首尾空白 → 全/半角空白折叠为单空格 → 去首尾标点 → 转小写 → 截断 200。
 */
export function normalizeIntent(prompt: string): string {
  if (!prompt) return ''
  return prompt
    .trim()
    .replace(/[　\s]+/g, ' ') // 全角空格(　)与半角空白统一为单空格
    .replace(/^[，。、！？!?.,;；:：\s]+/, '') // 去首部标点/空白
    .replace(/[，。、！？!?.,;；:：\s]+$/, '') // 去尾部标点/空白
    .toLowerCase()
    .slice(0, 200)
}

/**
 * 再生成语义词表：命中即视为「用户明确想要新的一张/另一个」，跳过意图去重。
 * 只收表达「重新/额外/另一张」的生成动作词，避免误伤（如「再想想」不含生成动作词）。
 */
const REGENERATION_PATTERNS: RegExp[] = [
  /再生成/,
  /重新生成/,
  /重画/,
  /再画/,
  /再出[一]?张/,
  /再来[一]?张/,
  /再给[我]?[一]?张/,
  /再做一个/,
  /再做[一]?个/,
  /第二张/,
  /第2张/,
  /另一个/,
  /换[一]?张/,
  /多[一]?张/,
  /额外[一]?张/,
]

/** 是否含再生成语义——命中则跳过意图去重，放行新生成。 */
export function isRegenerationIntent(prompt: string): boolean {
  if (!prompt) return false
  return REGENERATION_PATTERNS.some((re) => re.test(prompt))
}
