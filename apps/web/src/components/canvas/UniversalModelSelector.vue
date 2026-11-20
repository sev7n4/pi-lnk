<script setup lang="ts">
import { ref } from 'vue'
import type { AudioKind, GenerationType } from '@lnkpi/shared'
import { type StudioModality } from '@/constants/studioModels'
import { useClickOutside } from '@/composables/useClickOutside'
import { useModelSelectorOptions } from '@/composables/useModelSelectorOptions'
import DockTypeIcon from '@/components/canvas/dock-studio/shared/DockTypeIcon.vue'

/** 兼容既有 import：`SelectorModelOption` 从 composable 重导出。 */
export type { SelectorModelOption } from '@/composables/useModelSelectorOptions'

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

/* 模型选项投影抽至 composable（2026-11-20）：PC 锚定卡与移动底部 Sheet 共用同一数据源。
 * 依赖仍走 useProviderBootstrap / useModelHealth，既有 mock 契约不变。 */
const {
  selectableOptions,
  current,
  currentLabel,
  currentFullLabel,
  typeIcon,
  typeTitle,
  labelForValue,
  unavailableTitle,
} = useModelSelectorOptions({
  modelValue: () => props.modelValue,
  type: () => props.type,
  modality: () => props.modality,
  audioKind: () => props.audioKind,
})

function select(id: string) {
  // S1-3：unavailable 条目不可点（灰显防呆——点了也会在生成链路撞不可用）
  if (selectableOptions.value.find((m) => m.id === id)?.unavailable) return
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
      :title="currentFullLabel ? `${typeTitle} · ${currentFullLabel}` : typeTitle"
      @click="open = !open"
    >
      <DockTypeIcon :icon="typeIcon" :size="13" class="opacity-60" />
      <span class="max-w-[140px] truncate font-medium" :class="current?.disabled ? 'text-warning' : ''">
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
        class="flex w-full items-center justify-between px-3 py-2 text-xs text-warning"
        disabled
      >
        <span class="truncate">{{ labelForValue(current.id) }}</span>
        <span class="ml-2 shrink-0 text-warning">已停用</span>
      </button>
      <button
        v-for="model in selectableOptions"
        :key="model.id"
        type="button"
        class="neo-popover-item flex w-full items-center justify-between px-3 py-2 text-xs"
        :class="[
          model.id === modelValue && !model.unavailable
            ? '!bg-[var(--lnk-accent-subtle)] !text-[var(--lnk-accent-text)] shadow-[inset_0_0_0_1px_var(--lnk-accent-border)]'
            : '',
          model.unavailable ? 'cursor-not-allowed opacity-45' : '',
        ]"
        :disabled="model.unavailable || undefined"
        :title="model.unavailable ? unavailableTitle() : undefined"
        @click="select(model.id)"
      >
        <span class="truncate">{{ model.name }}</span>
        <span
          v-if="model.unavailable"
          class="ml-1 shrink-0 text-[10px] text-[var(--neo-warm,--neo-text-muted)]"
        >
          暂不可用
        </span>
        <span
          v-else-if="model.healthDot"
          class="model-health-dot ml-1 h-1.5 w-1.5 shrink-0 rounded-full"
          :class="model.healthDot.kind === 'red' ? 'bg-danger' : 'bg-warning'"
          :title="model.healthDot.title"
        />
        <span
          v-if="type === 'text' && model.visionCapable && !model.unavailable"
          class="ml-1 shrink-0 text-[10px] text-success"
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
