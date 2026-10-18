<script setup lang="ts">
import { computed } from 'vue'
import DockTypeIcon from './DockTypeIcon.vue'
import { DOCK_TYPE_LABELS, dockTypeToIcon } from './dockIcons'

const props = withDefaults(defineProps<{
  /** Node type key, e.g. text / image / video / audio */
  type?: string
  /** @deprecated Prefer `type` — kept for legacy panels */
  typeLabel?: string
  showTitle?: boolean
  title?: string
  titlePlaceholder?: string
  readonly?: boolean
  showClose?: boolean
}>(), {
  showClose: true,
})

const emit = defineEmits<{
  close: []
  'update:title': [value: string]
}>()

const iconKind = computed(() => dockTypeToIcon(props.type ?? 'text'))
const tooltip = computed(() => {
  if (props.type && DOCK_TYPE_LABELS[props.type]) return DOCK_TYPE_LABELS[props.type]
  return props.typeLabel ?? '节点'
})
</script>

<template>
  <div
    class="bottom-toolbar-container"
    :class="{ 'is-dock-readonly': readonly }"
    @click.stop
  >
    <div class="bottom-toolbar-header">
      <div class="flex items-center gap-2">
        <span class="bottom-toolbar-type-icon" :title="tooltip">
          <DockTypeIcon :icon="iconKind" :size="18" />
        </span>
        <input
          v-if="showTitle"
          :value="title"
          class="bottom-toolbar-title-input"
          :placeholder="titlePlaceholder ?? '节点标题'"
          :readonly="readonly"
          @input="emit('update:title', ($event.target as HTMLInputElement).value)"
        >
      </div>
      <!-- header 中段插槽（2026-10-18 方案 A）：选中节点快捷工具行落位处——
           图标底部压在 header 下沿，不新增行高，dock 总高度与缩略图态持平 -->
      <div class="flex min-w-0 flex-1 items-center mx-1">
        <slot name="header-mid" />
      </div>
      <div class="bottom-toolbar-header-end flex items-center gap-1">
        <slot name="header-end" />
        <button
          v-if="showClose"
          type="button"
          class="bottom-toolbar-close"
          aria-label="关闭"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
    <slot />
  </div>
</template>
