/**
 * 分组色卡预设（2026-10-12 P3）。
 *
 * 8 个低饱和预设键，色值本体在 `neowow-tokens.css` 以 `--neo-group-{key}`
 * 两主题成对定义（浅色取淡雅档、深色取沉郁档）；组件只消费令牌，禁止字面 hex。
 * 默认 neutral（中性灰）—— 分组默认色刻意避开品牌紫（紫色在本项目主色里
 * 占比已过高），与画布仅 3~5% 明度差，「有差异、不强占主视线」。
 */
export const GROUP_COLOR_KEYS = [
  'neutral',
  'moss',
  'dusk',
  'clay',
  'celadon',
  'graphite',
  'rose',
  'plum',
] as const

export type GroupColorKey = (typeof GROUP_COLOR_KEYS)[number]

export function normalizeGroupColorKey(raw: unknown): GroupColorKey {
  return GROUP_COLOR_KEYS.includes(raw as GroupColorKey) ? (raw as GroupColorKey) : 'neutral'
}
