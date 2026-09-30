<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { LinkedCanvasOutput } from '@lnkpi/shared'
import { ElMessage } from 'element-plus'
import DockTypeIcon from '@/components/canvas/dock-studio/shared/DockTypeIcon.vue'
import CanvasLocateButton from '@/components/shared/CanvasLocateButton.vue'
import {
  locatableNodeIds,
  shouldCollapseOutputs,
  visibleOutputCount,
} from '@/components/agent/agentCanvasOutputs'

const props = defineProps<{
  outputs: LinkedCanvasOutput[]
  /** P1#6：画布节点 url 解析器（SideRail 由 canvasNodes 提供）；缺省=旧行为纯文本行 */
  resolveNodeUrl?: (nodeId: string) => string | undefined
}>()

const emit = defineEmits<{
  focusNode: [nodeId: string]
  focusAll: [nodeIds: string[]]
}>()

const LOCATE_HINT_KEY = 'lnkpi:agentLocateHintShown'

const expanded = ref(false)
const pulseNodeIds = ref<Set<string>>(new Set())
const prevStatuses = ref<Map<string, LinkedCanvasOutput['status']>>(new Map())

const showCollapse = computed(() => shouldCollapseOutputs(props.outputs.length))
const visibleCount = computed(() => visibleOutputCount(props.outputs.length, expanded.value))
const visibleOutputs = computed(() =>
  showCollapse.value && !expanded.value
    ? props.outputs.slice(0, visibleCount.value)
    : props.outputs,
)
const locatableIds = computed(() => locatableNodeIds(props.outputs))
const showFocusAll = computed(() => locatableIds.value.length >= 2)

watch(
  () => props.outputs,
  (outputs) => {
    const nextPulse = new Set<string>()
    for (const out of outputs) {
      const prev = prevStatuses.value.get(out.nodeId)
      if (
        (out.status === 'done' || out.status === 'failed')
        && prev !== out.status
        && prev !== undefined
      ) {
        nextPulse.add(out.nodeId)
      }
      prevStatuses.value.set(out.nodeId, out.status)
    }
    if (nextPulse.size) {
      pulseNodeIds.value = new Set([...pulseNodeIds.value, ...nextPulse])
      for (const nodeId of nextPulse) {
        window.setTimeout(() => {
          const next = new Set(pulseNodeIds.value)
          next.delete(nodeId)
          pulseNodeIds.value = next
        }, 2000)
      }
    }
  },
  { deep: true, immediate: true },
)

function statusIcon(status: LinkedCanvasOutput['status']): string {
  switch (status) {
    case 'done':
      return '✓'
    case 'failed':
      return '✗'
    case 'running':
      return '⏳'
    default:
      return '○'
  }
}

function maybeShowLocateHint() {
  if (localStorage.getItem(LOCATE_HINT_KEY)) return
  localStorage.setItem(LOCATE_HINT_KEY, '1')
  ElMessage.info('点击图钉可在画布中找到对应节点')
}

function onLocate(nodeId: string) {
  maybeShowLocateHint()
  emit('focusNode', nodeId)
}

function onFocusAll() {
  if (!locatableIds.value.length) return
  maybeShowLocateHint()
  emit('focusAll', locatableIds.value)
}

function isPulsing(nodeId: string): boolean {
  return pulseNodeIds.value.has(nodeId)
}

/** P1#6 缩略图：图片直接 img；视频用 #t=0.1 首帧。无 url / 加载失败降级为类型 icon。 */
const VIDEO_URL_RE = /\.(mp4|webm|mov)(\?|$)/i
function nodeUrl(nodeId: string): string | undefined {
  const url = props.resolveNodeUrl?.(nodeId)
  return typeof url === 'string' && url ? url : undefined
}
function isVideoUrl(url: string): boolean {
  return VIDEO_URL_RE.test(url)
}
function hideBrokenImg(e: Event) {
  ;(e.target as HTMLImageElement).style.display = 'none'
}
</script>

<template>
  <div v-if="outputs.length" class="agent-canvas-outputs mt-1.5 border-t border-[var(--agent-assistant-divider)] pt-1.5">
    <div class="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--neo-text-muted)]">
      <span>画布产出 · {{ outputs.length }}</span>
      <CanvasLocateButton
        v-if="showFocusAll"
        :size="12"
        label="全部"
        title="在画布中定位全部"
        @click="onFocusAll"
      />
    </div>
    <ul class="space-y-1">
      <li
        v-for="item in visibleOutputs"
        :key="item.nodeId"
        class="flex items-center gap-1.5 text-[11px] leading-snug"
      >
        <span
          class="w-3 shrink-0 text-center"
          :class="item.status === 'failed' ? 'text-red-400/90' : 'text-[var(--neo-text-muted)]'"
        >{{ statusIcon(item.status) }}</span>
        <span
          v-if="item.status === 'done' && nodeUrl(item.nodeId)"
          class="relative block h-7 w-7 shrink-0 overflow-hidden rounded border border-[var(--neo-border)]"
          data-testid="output-thumb"
        >
          <video
            v-if="isVideoUrl(nodeUrl(item.nodeId)!)"
            :src="`${nodeUrl(item.nodeId)}#t=0.1`"
            muted
            preload="metadata"
            class="h-full w-full object-cover"
          />
          <img
            v-else
            :src="nodeUrl(item.nodeId)"
            :alt="item.title"
            loading="lazy"
            class="h-full w-full object-cover"
            @error="hideBrokenImg"
          />
          <span
            v-if="isVideoUrl(nodeUrl(item.nodeId)!)"
            class="absolute inset-0 flex items-center justify-center text-[9px] text-white/90"
          >▶</span>
        </span>
        <DockTypeIcon v-else :type="item.nodeType" :size="12" class="shrink-0 opacity-80" />
        <span
          class="min-w-0 flex-1 truncate"
          :class="item.status === 'failed' ? 'text-red-400/90' : 'text-[var(--neo-fg)]'"
        >{{ item.title }}</span>
        <CanvasLocateButton
          v-if="item.status === 'done' || item.status === 'failed'"
          :pulse="isPulsing(item.nodeId)"
          title="在画布中定位"
          @click="() => onLocate(item.nodeId)"
        />
        <span
          v-else-if="item.status === 'running'"
          class="shrink-0 text-[10px] text-[var(--neo-text-muted)] animate-pulse"
        >生成中…</span>
      </li>
    </ul>
    <button
      v-if="showCollapse && !expanded"
      type="button"
      class="mt-1 text-[10px] text-[var(--neo-text-secondary)] underline-offset-2 hover:text-[var(--neo-text-primary)] hover:underline"
      @click="expanded = true"
    >
      展开全部 {{ outputs.length }} 项
    </button>
  </div>
</template>
