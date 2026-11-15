<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import type { NodeRef } from '@/composables/useNodeRefs'
import AgentRefMediaBody from '@/components/agent/AgentRefMediaBody.vue'

const props = defineProps<{
  refItem: NodeRef
  x: number
  y: number
}>()

const emit = defineEmits<{
  close: []
}>()

const style = computed(() => {
  const margin = 12
  let left = props.x
  let top = props.y
  if (typeof window !== 'undefined') {
    if (left + 360 > window.innerWidth - margin) left = window.innerWidth - 360 - margin
    if (top + 280 > window.innerHeight - margin) top = Math.max(margin, props.y - 280)
    left = Math.max(margin, left)
    top = Math.max(margin, top)
  }
  return { left: `${left}px`, top: `${top}px` }
})

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}

onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[130]" @click="emit('close')">
      <div
        class="dock-ref-preview pointer-events-auto fixed w-[340px] max-h-[min(420px,70vh)] overflow-hidden rounded-xl border border-overlay/12 bg-surface-overlay text-fg shadow-2xl backdrop-blur-xl"
        :style="style"
        @click.stop
      >
        <div class="flex items-center justify-between border-b border-overlay/8 px-3 py-2">
          <span class="truncate text-xs text-fg-2">{{ refItem.refKey }} · {{ refItem.label }}</span>
          <button
            type="button"
            class="rounded-md p-1 text-fg-3 hover:bg-overlay/10 hover:text-fg"
            aria-label="关闭预览"
            @click="emit('close')"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="max-h-[calc(70vh-48px)] overflow-y-auto p-3">
          <AgentRefMediaBody :ref-item="refItem" expanded />
        </div>
      </div>
    </div>
  </Teleport>
</template>
