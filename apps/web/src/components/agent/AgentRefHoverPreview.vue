<script setup lang="ts">
/**
 * PC 侧栏素材 hover 卡（速览）/ pinned 卡（可交互详情）的**外壳**。
 * 四媒体内容统一委托 AgentRefMediaBody；这里只负责定位、固定态与关闭通道。
 *
 * ⚠️ 2026-11-15：底色从写死的深色半透明字面量换成语义面
 *    `bg-surface-overlay`（深主题深面+浅字 / 浅主题浅面+深字）。此前正文用 text-fg，
 *    浅色主题下深字压深底 ⇒ 6k 字文档「渲染了但一个字都看不见」（生产截图实证）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { NodeRef } from '@/composables/useNodeRefs'
import type { AnchorRect } from '@/utils/refPreviewPosition'
import { computeRefPreviewStyle } from '@/utils/refPreviewPosition'
import AgentRefMediaBody from './AgentRefMediaBody.vue'

const props = withDefaults(
  defineProps<{
    refItem: NodeRef
    anchor: AnchorRect
    /** 点芯片 / 点「展开」后钉住：不再随 mouseleave 关闭，出现关闭/引用动作 */
    pinned?: boolean
    actionLabel?: string
  }>(),
  { pinned: false, actionLabel: '' },
)

const emit = defineEmits<{
  mouseenter: []
  mouseleave: []
  close: []
  pin: []
  action: []
}>()

const style = computed(() => computeRefPreviewStyle(props.anchor))
const expanded = ref(props.pinned)
watch(() => props.pinned, (on) => { if (on) expanded.value = true })

function onExpand() {
  expanded.value = true
  emit('pin')
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !props.pinned) return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}
onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="pinned"
      class="fixed inset-0 z-[129]"
      data-testid="ref-preview-scrim"
      @click="emit('close')"
    />
    <div
      class="agent-ref-hover-preview pointer-events-auto fixed z-[130] w-[340px] overflow-hidden rounded-xl border border-overlay/12 bg-surface-overlay text-fg shadow-2xl backdrop-blur-xl"
      :class="pinned ? 'max-h-[85vh]' : 'max-h-[min(420px,70vh)]'"
      :style="style"
      data-testid="ref-preview-card"
      @mouseenter="emit('mouseenter')"
      @mouseleave="emit('mouseleave')"
      @click.stop
    >
      <div class="flex items-center justify-between gap-2 border-b border-overlay/8 px-3 py-2">
        <span class="min-w-0 truncate text-xs text-fg-2">{{ refItem.refKey }} · {{ refItem.label }}</span>
        <button
          v-if="pinned"
          type="button"
          class="shrink-0 rounded-md p-1 text-fg-3 hover:bg-overlay/10 hover:text-fg"
          aria-label="关闭预览"
          data-testid="ref-preview-close"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="max-h-[calc(85vh-84px)] overflow-y-auto p-3">
        <AgentRefMediaBody :ref-item="refItem" :expanded="expanded" @expand="onExpand" />
      </div>

      <div
        v-if="pinned && actionLabel"
        class="flex items-center justify-end border-t border-overlay/8 px-3 py-2"
      >
        <button
          type="button"
          class="rounded-md border border-line px-2 py-1 text-[11px] text-fg-2 hover:bg-overlay/10 hover:text-fg"
          data-testid="ref-preview-action"
          @click="emit('action')"
        >{{ actionLabel }}</button>
      </div>
    </div>
  </Teleport>
</template>
