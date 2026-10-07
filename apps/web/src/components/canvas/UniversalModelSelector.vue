<script setup lang="ts">
import { computed, ref } from 'vue'
import { supportsVisionTextModel, upstreamChatModel } from '@lnkpi/agent'
import type { AudioKind, GenerationType } from '@lnkpi/shared'
import { audioKindOf, decodeChannelModel, getModelEntry, modelOptionName } from '@lnkpi/shared'
import { type StudioModality } from '@/constants/studioModels'
import { useClickOutside } from '@/composables/useClickOutside'
import { useProviderBootstrap } from '@/composables/useProviderBootstrap'
import DockTypeIcon from '@/components/canvas/dock-studio/shared/DockTypeIcon.vue'
import type { DockNodeIconKind } from '@/components/canvas/dock-studio/shared/dockIcons'

export type SelectorModelOption = {
  id: string
  name: string
  channelName: string
  disabled?: boolean
  visionCapable?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    type: GenerationType
    /** Override catalog modality (e.g. audio when type is not in GenerationType) */
    modality?: StudioModality
    /** ghost：无边框，hover 才高亮（Agent / 单层 dock） */
    ghost?: boolean
    /**
     * 只对 audio 生效：按二阶分类过滤候选模型。缺省不过滤 ⇒ 存量调用零变化。
     *
     * 🔴 这不是锦上添花而是防错：服务端 `assertAudioKindMatchesModel` 对
     * 「声明 music 却拿着 TTS 模型」显式 400，所以选了分类后下拉不能列出别的分类。
     */
    audioKind?: AudioKind
  }>(),
  { ghost: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
useClickOutside(rootRef, () => {
  open.value = false
})

const { preferences, allChannels } = useProviderBootstrap()

const catalogModality = computed((): StudioModality => props.modality ?? props.type)

function selectableForModality(modality: StudioModality): string[] {
  const prefs = preferences.value
  if (!prefs) return []
  if (modality === 'image') return prefs.selectableImageModels
  if (modality === 'video') return prefs.selectableVideoModels
  if (modality === 'audio') return filterAudioByKind(prefs.selectableAudioModels)
  return prefs.selectableTextModels
}

/**
 * 只在 `audioKind` 给了的时候过滤（存量调用零变化）。
 *
 * 判定与服务端 `assertAudioKindMatchesModel` 同源：`audioKindOf(getModelEntry(name) ?? {modality:'audio'})`
 * —— 目录外模型（BYOK 自定义音频模型）按 voice 算，所以它们只在「配音」下出现。
 * 刻意不用「白名单 modelKey 集合」那种写法：那会把 BYOK 音频模型从配音下拉里一起抹掉。
 */
function filterAudioByKind(ids: string[]): string[] {
  const kind = props.audioKind
  if (!kind) return ids
  return ids.filter((id) => {
    const modelName = decodeChannelModel(id)?.modelName ?? id
    return audioKindOf(getModelEntry(modelName) ?? { modality: 'audio' }) === kind
  })
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

const selectableOptions = computed((): SelectorModelOption[] => {
  return selectableForModality(catalogModality.value).map((id) => ({
    id,
    name: modelOptionName(id),
    channelName: channelNameForValue(id),
    visionCapable: supportsVisionTextModel(upstreamChatModel(id)),
  }))
})

const current = computed((): SelectorModelOption | undefined => {
  const found = selectableOptions.value.find((m) => m.id === props.modelValue)
  if (found) return found
  if (props.modelValue) {
    return {
      id: props.modelValue,
      name: modelOptionName(props.modelValue),
      channelName: channelNameForValue(props.modelValue),
      disabled: true,
    }
  }
  return selectableOptions.value[0]
})

const currentLabel = computed(() => {
  if (!current.value) return '...'
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

function select(id: string) {
  emit('update:modelValue', id)
  open.value = false
}
</script>

<template>
  <div ref="rootRef" class="relative">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs"
      :class="[ghost ? 'dock-ghost-ctl' : 'neo-ctl', open ? 'is-open' : '']"
      :title="typeTitle"
      @click="open = !open"
    >
      <DockTypeIcon :icon="typeIcon" :size="13" class="opacity-60" />
      <span class="max-w-[140px] truncate font-medium" :class="current?.disabled ? 'text-amber-400/90' : ''">
        {{ currentLabel }}
      </span>
      <svg class="h-3 w-3 shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <div
      v-if="open"
      class="neo-popover absolute bottom-full left-0 z-50 mb-1 min-w-[220px] rounded-xl py-1"
      @click.stop
    >
      <button
        v-if="current?.disabled"
        type="button"
        class="flex w-full items-center justify-between px-3 py-2 text-xs text-amber-400/90"
        disabled
      >
        <span class="truncate">{{ labelForValue(current.id) }}</span>
        <span class="ml-2 shrink-0 text-amber-400/60">已停用</span>
      </button>
      <button
        v-for="model in selectableOptions"
        :key="model.id"
        type="button"
        class="neo-popover-item flex w-full items-center justify-between px-3 py-2 text-xs"
        :class="model.id === modelValue ? '!bg-[var(--neo-hi-bg)] !text-[var(--neo-hi-text)] shadow-[var(--neo-hi-shadow)]' : ''"
        @click="select(model.id)"
      >
        <span class="truncate">{{ model.name }}</span>
        <span
          v-if="type === 'text' && model.visionCapable"
          class="ml-1 shrink-0 text-[10px] text-emerald-400/80"
        >
          可识图
        </span>
        <span class="ml-2 shrink-0 opacity-45">{{ model.channelName }}</span>
      </button>
      <p v-if="!selectableOptions.length" class="px-3 py-2 text-[11px] text-[var(--neo-text-muted)]">
        暂无可选模型，请先在配置中设置
      </p>
    </div>
  </div>
</template>
