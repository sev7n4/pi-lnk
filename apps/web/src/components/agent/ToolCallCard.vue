<script setup lang="ts">
import { computed, ref } from 'vue'
import { presentToolStep } from '@/components/agent/toolPresentation'
import type { CollapsedToolCall } from '@/components/agent/collapseToolCalls'

const props = defineProps<{ call: CollapsedToolCall }>()
const expanded = ref(false)

const head = computed(() =>
  presentToolStep({
    kind: 'tool',
    label: `调用 ${props.call.name} · ${props.call.argsSummary ?? ''}`,
    meta: { toolName: props.call.name, args: props.call.argsSummary },
  }),
)

const resultSummary = computed(() => {
  const r = props.call.result
  if (r == null) return undefined
  if (typeof r === 'string') return r.slice(0, 200)
  const m = (r as { message?: string }).message
  if (typeof m === 'string') return m.slice(0, 200)
  try {
    return JSON.stringify(r).slice(0, 200)
  } catch {
    return undefined
  }
})

const hasDetail = computed(() => props.call.result != null)
</script>

<template>
  <div class="agent-tool-card text-[10px] text-[var(--neo-text-secondary)]">
    <button
      type="button"
      class="flex w-full items-center gap-1 text-left"
      :disabled="!hasDetail"
      @click="expanded = !expanded"
    >
      <span class="shrink-0">{{ head.icon }} {{ head.label }}</span>
      <span v-if="call.count > 1" class="shrink-0 opacity-70">× {{ call.count }}</span>
      <span v-if="hasDetail" class="shrink-0 opacity-60">{{ expanded ? '▾' : '▸' }}</span>
    </button>
    <pre
      v-if="expanded && hasDetail"
      class="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/20 px-1.5 py-1 text-[10px]"
      data-testid="tool-result-detail"
    >{{ resultSummary }}</pre>
  </div>
</template>
