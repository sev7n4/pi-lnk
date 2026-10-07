<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from 'vue'
import { useNodeId } from '@vue-flow/core'
import type { TaskKind } from '@lnkpi/shared'
import NodeDiagnosticPopover from '@/components/canvas/NodeDiagnosticPopover.vue'
import { resolveTaskChrome, truncateError } from '@/components/canvas/nodeTaskChrome'
import { CANVAS_NODE_CANCEL_KEY, CANVAS_NODE_RETRY_KEY } from '@/composables/canvasNodeActions'
import { useNodeDiagnostic } from '@/composables/useNodeDiagnostic'
import { NODE_GENERATION_STATUS } from '@/constants/dockStudio'

const props = defineProps<{
  status?: unknown
  startedAt?: string
  errorMessage?: string
  errorCode?: string
  taskKind?: TaskKind
  taskId?: string
  nodeLabel?: string
  sessionId?: string
  /**
   * 报错详情入口（2026-10-07 与用户拍板）：
   * 'row'（默认）= 保留按钮上方的错误行 + ⓘ（无左上角状态图标的节点类型用）；
   * 'status-icon' = 不渲染错误行，报错详情统一收敛到节点左上角状态图标
   *   （NodeStatusInfoButton），同时保证重试/取消按钮位置与生成中状态完全一致。
   */
  errorDetail?: 'row' | 'status-icon'
}>()

const nodeId = useNodeId()
const cancel = inject(CANVAS_NODE_CANCEL_KEY, null)
const retry = inject(CANVAS_NODE_RETRY_KEY, null)

const nowMs = ref(Date.now())
const completedFlash = ref(false)
let tick: ReturnType<typeof setInterval> | undefined
let flashTimer: ReturnType<typeof setTimeout> | undefined

const isFallbackPending = computed(
  () => props.status === NODE_GENERATION_STATUS.fallback_pending,
)

const {
  open: diagOpen,
  loading: diagLoading,
  popoverMessage,
  popoverHint,
  copyLabel,
  toggle: toggleDiag,
  close: closeDiag,
  copyDiag,
} = useNodeDiagnostic({
  taskKind: () => props.taskKind,
  taskId: () => props.taskId,
  errorMessage: () => props.errorMessage,
  errorCode: () => props.errorCode,
  pending: () => isFallbackPending.value,
  nodeId: () => nodeId || undefined,
  nodeLabel: () => props.nodeLabel,
  sessionId: () => props.sessionId,
})

watch(
  () => props.status,
  (s, prev) => {
    if (s === NODE_GENERATION_STATUS.completed && prev && prev !== NODE_GENERATION_STATUS.completed) {
      completedFlash.value = true
      clearTimeout(flashTimer)
      flashTimer = setTimeout(() => {
        completedFlash.value = false
      }, 2000)
    }
  },
)

watch(
  () => props.status,
  (s) => {
    clearInterval(tick)
    if (s === NODE_GENERATION_STATUS.generating) {
      nowMs.value = Date.now()
      tick = setInterval(() => {
        nowMs.value = Date.now()
      }, 1000)
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  clearInterval(tick)
  clearTimeout(flashTimer)
})

const chrome = computed(() =>
  resolveTaskChrome({
    status: props.status,
    startedAt: props.startedAt,
    nowMs: nowMs.value,
    completedFlash: completedFlash.value,
  }),
)

const err = computed(() => truncateError(props.errorMessage))
const showError = computed(
  () =>
    (Boolean(err.value) &&
      (props.status === NODE_GENERATION_STATUS.error ||
        props.status === NODE_GENERATION_STATUS.failed ||
        isFallbackPending.value)) ||
    isFallbackPending.value,
)
const displayErr = computed(() => {
  if (err.value) return err.value
  if (isFallbackPending.value) return '平台回退待确认'
  return ''
})

const isClickable = computed(
  () => chrome.value?.action === 'cancel' || chrome.value?.action === 'retry',
)

function onAction(e: Event) {
  e.stopPropagation()
  e.preventDefault()
  if (!nodeId || !chrome.value?.action) return
  if (chrome.value.action === 'cancel') cancel?.(nodeId)
  if (chrome.value.action === 'retry') void retry?.(nodeId)
}
</script>

<template>
  <div
    v-if="chrome"
    class="neo-task-chrome nodrag nopan"
    @pointerdown.stop
    @mousedown.stop
    @click.stop
  >
    <div v-if="showError && errorDetail !== 'status-icon'" class="neo-task-error-wrap">
      <p class="neo-task-error-row">
        <span class="neo-task-error">{{ displayErr }}</span>
        <button
          type="button"
          class="neo-task-diag-btn"
          aria-label="诊断信息"
          title="诊断信息"
          @click="toggleDiag"
        >
          ⓘ
        </button>
      </p>
      <NodeDiagnosticPopover
        v-if="diagOpen"
        :user-message="popoverMessage"
        :hint="popoverHint"
        :loading="diagLoading"
        :copy-label="copyLabel"
        @copy="copyDiag"
        @close="closeDiag"
      />
    </div>
    <div class="neo-task-chrome-row">
      <span v-if="chrome.elapsedText" class="neo-task-elapsed">{{ chrome.elapsedText }}</span>
      <button
        type="button"
        class="neo-task-chrome-btn"
        :class="[
          `is-${chrome.tone}`,
          {
            'is-clickable': isClickable,
            'is-flash': chrome.flashSuccess,
          },
        ]"
        :title="
          chrome.action === 'cancel'
            ? '取消生成'
            : chrome.action === 'retry'
              ? '重试'
              : chrome.tone === 'pending'
                ? '待确认'
                : undefined
        "
        :aria-label="
          chrome.action === 'cancel'
            ? '取消生成'
            : chrome.action === 'retry'
              ? '重试'
              : chrome.tone === 'pending'
                ? '待确认'
                : '已完成'
        "
        :disabled="!isClickable"
        @click="onAction"
      >
        <span v-if="chrome.showSpinner" class="neo-task-spinner" aria-hidden="true" />
        <svg
          v-else-if="chrome.action === 'retry'"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
        <svg
          v-else-if="chrome.tone === 'pending'"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        <svg
          v-else-if="chrome.flashSuccess"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </button>
    </div>
  </div>
</template>
