/**
 * 模型展示名映射（规格 2026-11-03-credit-consumption-display-design.md §14.5-C8）。
 *
 * 背景：`settled.model` / record.model 等内部字段是**渠道前缀 key**
 * （`platform::agnes-2.5-flash` / `ch_xxx::<model>`），原样透出给用户会泄漏
 * 渠道路由的内部结构（生产实例：回合摘要「共消耗 7 积分 · platform::agnes-2.5-flash」）。
 *
 * 判据 C8：用户可见文案里的模型名必须经本模块映射；
 * 目录 displayName 缺失时降级为**剥前缀裸名**，绝不原样透出渠道前缀。
 */

/** 渠道前缀分隔符：`platform::<model>`、`<channelId>::<model>`（BYOK 渠道 id 形如 ch_xxx）。 */
const CHANNEL_SEP = '::'

/**
 * 剥渠道前缀，返回裸模型名。
 * - `platform::agnes-2.5-flash` → `agnes-2.5-flash`
 * - `ch_abc::my-model` → `my-model`
 * - 无前缀（裸名）原样透传；空/null/undefined 原样返回（调用方自行兜底）。
 *
 * ⚠️ 只剥**第一个** `::` 之前的部分；模型名本身不含 `::`（编码纪律见归一层）。
 */
export function stripChannelPrefix(modelKey: string | null | undefined): string {
  if (!modelKey) return modelKey ?? ''
  const idx = modelKey.indexOf(CHANNEL_SEP)
  return idx >= 0 ? modelKey.slice(idx + CHANNEL_SEP.length) : modelKey
}

/** 目录查找签名：modelKey（含渠道前缀）→ 展示名；未命中返回 undefined。 */
export type ModelNameLookup = (modelKey: string) => string | undefined

/**
 * 解析用户可见的模型展示名。
 * 1. 有目录 lookup 且命中 → 目录 displayName（平台渠道=目录名；BYOK 渠道镜像同此路径）；
 * 2. 未命中/无 lookup → 降级 `stripChannelPrefix` 裸名（C8 兜底，绝不透出渠道前缀）；
 * 3. 入参为空 → 空串（调用方决定是否省略该段）。
 */
export function resolveModelDisplayName(
  modelKey: string | null | undefined,
  lookup?: ModelNameLookup,
): string {
  if (!modelKey) return ''
  const hit = lookup?.(modelKey)
  if (hit && hit.trim()) return hit.trim()
  return stripChannelPrefix(modelKey)
}

/**
 * 结算/摘要文案的模型名后缀：` · <展示名>`；模型名缺省 → 空串（该段整体省略）。
 * 单一出口供 `turnSettledText`（executionTrace）与 `composeSettledSegment`
 * （turnTimeline 摘要）共用——C7：同一笔 turn_settled 在两个表面模型名口径一致。
 */
export function modelDisplaySuffix(
  modelKey: string | null | undefined,
  lookup?: ModelNameLookup,
): string {
  const name = resolveModelDisplayName(modelKey, lookup)
  return name ? ` · ${name}` : ''
}
