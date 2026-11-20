import { type ComputedRef, computed } from 'vue'
import { supportsVisionTextModel, upstreamChatModel } from '@lnkpi/agent'
import type { AudioKind, GenerationType } from '@lnkpi/shared'
import { decodeChannelModel, modelOptionName } from '@lnkpi/shared'
import { type StudioModality } from '@/constants/studioModels'
import { audioKindOfModelValue } from '@/constants/dockAudio'
import { friendlyModelName } from '@/components/agent/composer/modelSkillDedup'
import type { DockNodeIconKind } from '@/components/canvas/dock-studio/shared/dockIcons'
import { useProviderBootstrap } from './useProviderBootstrap'
import {
  availabilityOfModel,
  healthDotOfModel,
  useModelHealth,
  type ModelHealthDot,
} from './useModelHealth'

export type SelectorModelOption = {
  id: string
  name: string
  channelName: string
  disabled?: boolean
  visionCapable?: boolean
  /** S1-3 探活灰显：仅平台渠道 `unavailable` 置灰（unknown/缺字段照常可选）。 */
  unavailable?: boolean
  /** S1-3 健康角标（A4）：近 24h 成功率 <0.5 红 / <0.9 黄 / 其余无。 */
  healthDot?: ModelHealthDot | null
}

/**
 * 模型选择器纯数据投影（2026-11-20 抽离）：PC 锚定卡与移动底部 Sheet 共用同一数据源，
 * 双形态只换外壳、不复制 selectableOptions/current/角标逻辑。
 * 依赖仍走 `useProviderBootstrap` / `useModelHealth` composable（既有 mock 契约不变）。
 */
export function useModelSelectorOptions(opts: {
  modelValue: () => string
  type: () => GenerationType
  modality?: () => StudioModality | undefined
  audioKind?: () => AudioKind | undefined
}) {
  const { preferences, allChannels } = useProviderBootstrap()
  const modelHealth = useModelHealth()

  const catalogModality = computed((): StudioModality => opts.modality?.() ?? opts.type())

  function filterAudioByKind(ids: string[]): string[] {
    const kind = opts.audioKind?.()
    if (!kind) return ids
    return ids.filter((id) => audioKindOfModelValue(id) === kind)
  }

  function selectableForModality(modality: StudioModality): string[] {
    const prefs = preferences.value
    if (!prefs) return []
    if (modality === 'image') return prefs.selectableImageModels
    if (modality === 'video') return prefs.selectableVideoModels
    if (modality === 'audio') return filterAudioByKind(prefs.selectableAudioModels)
    return prefs.selectableTextModels
  }

  function channelNameForValue(value: string): string {
    const decoded = decodeChannelModel(value)
    if (!decoded) return '未知渠道'
    const ch = allChannels.value.find((c) => c.id === decoded.channelId)
    return ch?.name || decoded.channelId
  }

  function labelForValue(value: string): string {
    return `${modelOptionName(value)}（${channelNameForValue(value)}）`
  }

  const selectableOptions: ComputedRef<SelectorModelOption[]> = computed(() => {
    const channels = allChannels.value
    const healthRows = modelHealth.value?.rows
    return selectableForModality(catalogModality.value).map((id) => {
      const unavailable = availabilityOfModel(channels, id) === 'unavailable'
      return {
        id,
        name: modelOptionName(id),
        channelName: channelNameForValue(id),
        visionCapable: supportsVisionTextModel(upstreamChatModel(id)),
        unavailable,
        healthDot: unavailable ? null : healthDotOfModel(healthRows, id),
      }
    })
  })

  const current = computed((): SelectorModelOption | undefined => {
    const found = selectableOptions.value.find((m) => m.id === opts.modelValue())
    if (found) return found
    if (opts.modelValue()) {
      return {
        id: opts.modelValue(),
        name: modelOptionName(opts.modelValue()),
        channelName: channelNameForValue(opts.modelValue()),
        disabled: true,
      }
    }
    return selectableOptions.value[0]
  })

  // P2-6.1：chip 文案截断（模型名 >12 字符取前 12 + '…'），完整名进按钮 title tooltip
  const currentLabel = computed(() => {
    if (!current.value) return '...'
    const base = `${friendlyModelName(current.value.name)}（${current.value.channelName}）`
    return current.value.disabled ? `${base} · 已停用` : base
  })

  const currentFullLabel = computed(() => {
    if (!current.value) return undefined
    const base = `${current.value.name}（${current.value.channelName}）`
    return current.value.disabled ? `${base} · 已停用` : base
  })

  const typeIcon = computed((): DockNodeIconKind => {
    const m = catalogModality.value
    if (m === 'image') return 'image'
    if (m === 'video') return 'video'
    if (m === 'audio') return 'audio'
    return 'text'
  })

  const typeTitle = computed(() => {
    const m = catalogModality.value
    if (m === 'text') return '文本模型'
    if (m === 'image') return '图像模型'
    if (m === 'video') return '视频模型'
    if (m === 'audio') return '音频模型'
    return '模型'
  })

  /** 灰显条目 hover：暂不可用 + 最近探活统计时间（若健康投影响应携带）。 */
  function unavailableTitle(): string {
    const generatedAt = modelHealth.value?.generatedAt
    const base = '暂不可用 · 平台暂未开通'
    if (!generatedAt) return base
    const time = new Date(generatedAt).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    return `${base}（最近探活 ${time}）`
  }

  return {
    selectableOptions,
    current,
    currentLabel,
    currentFullLabel,
    typeIcon,
    typeTitle,
    catalogModality,
    labelForValue,
    unavailableTitle,
  }
}
