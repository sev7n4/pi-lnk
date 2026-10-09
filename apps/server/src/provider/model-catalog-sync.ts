/**
 * 模型目录自动对齐的**纯逻辑**部分（IO 落在 ProviderService 的
 * ensurePlatformChannel / ensurePreferences / updatePreferences）。
 *
 * 背景（P1，2026-10-09）：
 * `ensurePlatformChannel` 对已存在的平台渠道只更新 baseUrl、`ensurePreferences` 对已存在
 * 用户直接 return —— 上新模型后平台渠道 `models` 与存量用户 `selectable*Models` 都是历史
 * 快照，必须人工回填（StepFun 42 用户回填即其后果）。本模块让 bootstrap 自动对齐：
 *
 * - 平台渠道 `models`：只读系统目录镜像（`updateChannel` 对 platform 抛 Forbidden，用户
 *   无法个性化）⇒ 直接对齐当前目录。对齐函数复用 audio-model-backfill.ts 的
 *   `planPlatformChannelSync`（已带测试）。
 * - 用户 `selectable*Models`：难点是「用户主动停用」与「模型新上架」在快照里**同形**
 *   （audio-model-backfill.ts 头注释已识别，因此它只敢做一次性人工脚本）。
 *   解法 = `UserAiPreferences.disabledModels`（JSON 数组，存编码后的 `platform::<modelKey>`）
 *   显式记录用户停用行为：
 *   - 停用记录由 `updatePreferences` 内的 `planDisabledModelsOnPreferencesUpdate` 从
 *     prev/next 全量列表 **diff 推导**（前端 ProviderConfigDialog 本来就全量 PUT，前端零改动）；
 *   - bootstrap 对齐（`planUserSelectableSyncRow`）只并入「目录新增 ∧ 未被停用」的条目，
 *     并清掉目录已不存在的选择（BYOK 条目一律保留、不重排既有顺序）。
 *
 * 边界口径：
 * - `disabledModels` 只记录目录内的平台模型；BYOK 模型摘除本来就不会被对齐复活，无需记录。
 * - 目录移除某模型后，它的停用记录一并清理；若模型重新上架，视为新模型并入。
 * - `excludeFromPrev`（= ensurePreferences 本次 sync 刚并入的条目）：用户前端草稿加载于
 *   并入之前时，保存请求里自然没有它们 —— 不能据此判为「用户主动停用」。
 */

import type { StudioModality } from '@lnkpi/shared'

/** DB 行里与对齐相关的 JSON 字符串字段（列名与 Prisma 逐字一致，见 audio-model-backfill 的历史教训）。 */
export type SelectableFieldsRow = {
  selectableImageModels: string
  selectableVideoModels: string
  selectableTextModels: string
  selectableAudioModels: string
  disabledModels: string
}

export const SELECTABLE_FIELD_BY_MODALITY: Record<StudioModality, keyof SelectableFieldsRow> = {
  image: 'selectableImageModels',
  video: 'selectableVideoModels',
  text: 'selectableTextModels',
  audio: 'selectableAudioModels',
}

const MODALITIES = ['image', 'video', 'text', 'audio'] as const

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    // 存量脏数据按空数组处理（保守向可用性倾斜），调用方会把目录条目补进去。
    return []
  }
}

export interface UserSelectableSyncPlan {
  /** 要写库的字段 → JSON 值。只含发生变化的字段；空对象 = 已对齐。 */
  data: Record<string, string>
  /** 每个 modality 本次并入的条目（编码值）。供 updatePreferences 的停用 diff 排除。 */
  added: Partial<Record<StudioModality, string[]>>
  changed: boolean
  reason: string
}

/**
 * 把一个用户的四个 selectable 快照对齐到当前目录。
 *
 * 口径（可审计、可复现）：
 * - **只并入、绝不重排**：既有条目在前（保持用户顺序），新增条目追加在尾。
 * - 平台条目（`platformPrefix` 开头）若目录里已不存在 ⇒ 从快照清掉（菜单不再提供死模型）；
 *   BYOK 条目（其他渠道前缀）一律保留。
 * - 目录新增 ∧ 未被 `disabledModels` 记录 ⇒ 并入；被停用的不复活。
 * - `disabledModels` 里目录已不存在的条目清掉（防无限增长；重新上架视为新模型）。
 */
export function planUserSelectableSyncRow(
  row: SelectableFieldsRow,
  catalogEncodedByModality: Record<StudioModality, string[]>,
  platformPrefix: string,
): UserSelectableSyncPlan {
  const disabled = parseStringArray(row.disabledModels)
  const disabledSet = new Set(disabled)
  const data: Record<string, string> = {}
  const added: Partial<Record<StudioModality, string[]>> = {}
  const addedCount: string[] = []
  const prunedCount: string[] = []

  const allCatalog = new Set<string>()
  for (const list of Object.values(catalogEncodedByModality)) {
    for (const entry of list) allCatalog.add(entry)
  }

  for (const modality of MODALITIES) {
    const field = SELECTABLE_FIELD_BY_MODALITY[modality]
    const current = parseStringArray(row[field])
    const catalogEncoded = catalogEncodedByModality[modality]
    const catalogSet = new Set(catalogEncoded)
    const keep = current.filter((m) => !m.startsWith(platformPrefix) || catalogSet.has(m))
    const keptSet = new Set(keep)
    const toAdd = catalogEncoded.filter((m) => !keptSet.has(m) && !disabledSet.has(m))
    if (toAdd.length > 0 || keep.length !== current.length) {
      data[field] = JSON.stringify([...keep, ...toAdd])
      prunedCount.push(`${modality}:${current.length - keep.length}`)
      if (toAdd.length > 0) {
        added[modality] = toAdd
        addedCount.push(`${modality}:${toAdd.length}`)
      }
    }
  }

  const disabledKept = disabled.filter((m) => allCatalog.has(m))
  if (disabledKept.length !== disabled.length) {
    data.disabledModels = JSON.stringify(disabledKept)
  }

  const changed = Object.keys(data).length > 0
  const reason = changed
    ? `并入 ${addedCount.join(',') || '0'} 条，清理 ${prunedCount.join(',') || '0'} 条`
    : '已与目录一致'
  return { data, added, changed, reason }
}

export interface DisabledDiffPlan {
  /** 目标 disabledModels（序列化前的数组，已按既有顺序去重）。 */
  target: string[]
  newlyDisabled: string[]
  reEnabled: string[]
  changed: boolean
}

/**
 * 从「旧 selectable 快照 vs 本次请求的全量列表」推导停用清单变化。
 *
 * 只遍历目录内的平台模型：
 * - 旧有新无 ⇒ 用户停用（且未记录过时）记入 disabledModels；
 * - 旧无（或被排除）新有 ∧ 已在停用清单 ⇒ 重新启用，移出 disabledModels；
 * - BYOK 条目的增删不记录（对齐永远不会复活它们）。
 *
 * `excludeFromPrev`：ensurePreferences 本次 sync 刚并入的条目。用户草稿加载于并入之前时
 * 请求里没有它们，但那不是「主动停用」—— 必须从 prev 侧排除。
 */
export function planDisabledModelsOnPreferencesUpdate(
  prev: SelectableFieldsRow,
  next: Partial<Record<StudioModality, string[]>>,
  catalogEncodedByModality: Record<StudioModality, string[]>,
  excludeFromPrev: Partial<Record<StudioModality, string[]>> = {},
): DisabledDiffPlan {
  const disabled = parseStringArray(prev.disabledModels)
  const disabledSet = new Set(disabled)
  const newlyDisabled: string[] = []
  const reEnabled: string[] = []

  for (const modality of MODALITIES) {
    const nextList = next[modality]
    if (!nextList) continue
    const nextSet = new Set(nextList)
    const prevList = parseStringArray(prev[SELECTABLE_FIELD_BY_MODALITY[modality]])
    const prevSet = new Set(prevList)
    for (const excluded of excludeFromPrev[modality] ?? []) prevSet.delete(excluded)
    for (const m of catalogEncodedByModality[modality]) {
      if (prevSet.has(m) && !nextSet.has(m) && !disabledSet.has(m)) newlyDisabled.push(m)
      if (nextSet.has(m) && disabledSet.has(m)) reEnabled.push(m)
    }
  }

  const reEnabledSet = new Set(reEnabled)
  const target = [
    ...disabled.filter((m) => !reEnabledSet.has(m)),
    ...newlyDisabled,
  ]
  return {
    target,
    newlyDisabled,
    reEnabled,
    changed: newlyDisabled.length > 0 || reEnabled.length > 0,
  }
}
