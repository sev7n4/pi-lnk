/**
 * 分组色卡预设的前端入口（2026-10-21 起为 **shared 的 re-export**）。
 *
 * ## 为什么不再自有副本
 *
 * 此前 8 键只定义在这里，服务端 `setGroupColor` **无任何校验**（DTO 是自由
 * `string | null`）⇒ 非法色键能一路写进 `canvasData.groups`，失败发生在很远的
 * 前端渲染层且**静默**（`normalizeGroupColorKey` 落 neutral，用户读成「设了没反应」）。
 *
 * Agent 要自主设置分组背景色，就必须在**写入口**有白名单。白名单下沉到
 * `@lnkpi/shared`（`canvasGroup.ts`）后，本文件只做转发 + 保留前端便利函数。
 *
 * 8 个低饱和预设，色值本体在 `design-tokens.css` 以 `--lnk-group-{key}`
 * 两主题成对定义（浅色取淡雅档、深色取沉郁档）；组件只消费令牌，禁止字面 hex。
 * 默认 neutral（中性灰）—— 分组默认色刻意避开品牌紫（紫色在本项目主色里
 * 占比已过高），与画布仅数个百分点明度差，「有差异、不强占主视线」。
 *
 * ⛔ 改色卡必须改 `packages/shared/src/canvasGroup.ts` 的 `GROUP_COLOR_KEYS`
 * 并同步 `apps/web/src/styles/design-tokens.css` 的 `--lnk-group-{key}`
 * （两主题成对定义）—— 只改一处就会出现「键存在但色值为空」。
 */
import {
  DEFAULT_GROUP_COLOR_KEY,
  GROUP_COLOR_KEYS,
  type GroupColorKey,
} from '@lnkpi/shared'

export { GROUP_COLOR_KEYS, DEFAULT_GROUP_COLOR_KEY }
export type { GroupColorKey }

/**
 * 任意输入 → 合法色键；非法值静默落 `neutral`。
 *
 * 与 shared 的 `parseGroupColorKey` 语义**故意不同**：那个返回 `null` 让调用方
 * 决定报错还是复位（用在写入口）；这个必须「无论如何都能画」，所以兜底成合法色
 * （用在渲染层）。⚠️ 两处别混用。
 */
export function normalizeGroupColorKey(raw: unknown): GroupColorKey {
  return GROUP_COLOR_KEYS.includes(raw as GroupColorKey)
    ? (raw as GroupColorKey)
    : DEFAULT_GROUP_COLOR_KEY
}