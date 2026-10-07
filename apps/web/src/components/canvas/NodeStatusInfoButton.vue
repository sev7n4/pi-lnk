<script setup lang="ts">
import { computed } from 'vue'
import type { TaskKind } from '@lnkpi/shared'
import { useMediaInspector } from '@/composables/useMediaInspector'
import { NODE_GENERATION_STATUS } from '@/constants/dockStudio'

/**
 * 节点左上角状态图标（2026-10-07 与用户拍板；2026-10-08 重构详情入口）：
 * - 正常态：点开媒体属性抽屉（属性 tab）
 * - 异常态（失败/错误 → 红，fallback 待确认 → 黄 + 脉冲）：直落抽屉「诊断」tab
 *   —— 节点内弹层已删除（弹层被节点 overflow:hidden 裁切 + 长英文 token 撑破），
 *   详情统一收进右侧抽屉：一个入口、一份内容，颜色表状态。
 */
const props = defineProps<{
  status?: unknown
  taskKind?: TaskKind
  taskId?: string
  nodeLabel?: string
}>()

const emit = defineEmits<{
  inspect: []
}>()

const { openInspector } = useMediaInspector()

const isError = computed(
  () =>
    props.status === NODE_GENERATION_STATUS.error || props.status === NODE_GENERATION_STATUS.failed,
)
const isPending = computed(() => props.status === NODE_GENERATION_STATUS.fallback_pending)
const hasErrorDetail = computed(
  () => (isError.value || isPending.value) && Boolean(props.taskId),
)

const toneClass = computed(() => {
  if (!hasErrorDetail.value) return null
  return isPending.value ? 'is-pending' : 'is-error'
})

function onClick(e: Event) {
  e.stopPropagation()
  e.preventDefault()
  if (!hasErrorDetail.value) {
    emit('inspect')
    return
  }
  // 异常态：直落抽屉「诊断」tab（仅 generation 记录可查诊断）
  if (props.taskKind === 'generation' && props.taskId) {
    void openInspector({
      generationRecordId: props.taskId,
      nodeLabel: props.nodeLabel,
      initialTab: 'diagnostic',
    })
  }
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
  </span>
</template>
