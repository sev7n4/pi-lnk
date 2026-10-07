<script setup lang="ts">
import { computed } from 'vue'
import type { TaskKind } from '@lnkpi/shared'
import NodeDiagnosticPopover from '@/components/canvas/NodeDiagnosticPopover.vue'
import { useNodeDiagnostic } from '@/composables/useNodeDiagnostic'
import { NODE_GENERATION_STATUS } from '@/constants/dockStudio'

/**
 * 节点左上角状态图标（2026-10-07 与用户拍板）：
 * 详情入口统一——正常态点开媒体属性；异常态（失败/错误 → 红，fallback 待确认 → 黄）
 * 点开报错诊断详情。图标形状不变，只变颜色。
 */
const props = defineProps<{
  status?: unknown
  errorMessage?: string
  errorCode?: string
  taskKind?: TaskKind
  taskId?: string
  nodeLabel?: string
  sessionId?: string
}>()

const emit = defineEmits<{
  inspect: []
}>()

const isError = computed(
  () =>
    props.status === NODE_GENERATION_STATUS.error || props.status === NODE_GENERATION_STATUS.failed,
)
const isPending = computed(() => props.status === NODE_GENERATION_STATUS.fallback_pending)
const hasErrorDetail = computed(
  () => (isError.value || isPending.value) && Boolean(props.errorMessage || props.taskId),
)

const toneClass = computed(() => {
  if (!hasErrorDetail.value) return null
  return isPending.value ? 'is-pending' : 'is-error'
})

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
  pending: () => isPending.value,
  nodeLabel: () => props.nodeLabel,
  sessionId: () => props.sessionId,
})

function onClick(e: Event) {
  e.stopPropagation()
  e.preventDefault()
  if (hasErrorDetail.value) void toggleDiag()
  else emit('inspect')
}
</script>

<template>
  <span class="neo-status-info nodrag nopan" @pointerdown.stop @mousedown.stop @click.stop>
    <button
      type="button"
      class="neo-media-inspector-btn neo-status-info-btn"
      :class="toneClass"
      :aria-label="hasErrorDetail ? '报错详情' : '媒体属性'"
      :title="hasErrorDetail ? '报错详情' : '媒体属性'"
      @click="onClick"
    >
      ⓘ
    </button>
    <NodeDiagnosticPopover
      v-if="diagOpen"
      :user-message="popoverMessage"
      :hint="popoverHint"
      :loading="diagLoading"
      :copy-label="copyLabel"
      @copy="copyDiag"
      @close="closeDiag"
    />
  </span>
</template>
