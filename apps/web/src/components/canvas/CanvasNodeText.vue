<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useNodeId, useVueFlow } from '@vue-flow/core'
import NeoBaseNode from '@/components/canvas/NeoBaseNode.vue'
import NodeTaskCornerActions from '@/components/canvas/NodeTaskCornerActions.vue'
import NodeStatusInfoButton from '@/components/canvas/NodeStatusInfoButton.vue'
import PromptMarkdownEditor from '@/components/canvas/PromptMarkdownEditor.vue'
import { CANVAS_NODE_PATCH_KEY } from '@/composables/canvasNodeActions'
import { NODE_GENERATION_STATUS } from '@/constants/dockStudio'

const props = defineProps<{
  selected?: boolean
  data: {
    content: string
    label?: string
    status?: string
    errorMessage?: string
    errorCode?: string
    generationStartedAt?: string
    generationRecordId?: string
    materialId?: string
  }
}>()

const nodeId = useNodeId()
const { updateNodeData } = useVueFlow()
// 画布是受控模式(nodes.value 为真源),必须走页面级 patch 才能持久化并让下游引用可见;
// updateNodeData 只写 Vue Flow 内部 store,会在下一次页面 patch 时被旧数据覆盖。
const patchCanvasNode = inject(CANVAS_NODE_PATCH_KEY, null)
const route = useRoute()
const sessionId = computed(() => route.params.sessionId as string | undefined)
const taskId = computed(
  () =>
    (typeof props.data.generationRecordId === 'string' && props.data.generationRecordId) ||
    (typeof props.data.materialId === 'string' && props.data.materialId) ||
    undefined,
)
const taskKind = computed(() =>
  typeof props.data.generationRecordId === 'string' && props.data.generationRecordId
    ? ('generation' as const)
    : typeof props.data.materialId === 'string' && props.data.materialId
      ? ('material' as const)
      : undefined,
)

const editorOpen = ref(false)
const draft = ref('')

/**
 * 左上角状态图标仅异常态渲染（2026-10-09 对齐图片节点 2026-10-07/08 拍板）：
 * 文本节点没有媒体属性抽屉，常态不渲染常驻 ⓘ；失败/错误 → 红、fallback 待确认 → 黄，
 * 点击直落媒体属性抽屉「诊断」tab（诊断信息从右侧弹出）。
 * 仅 generation 记录有诊断接口（material 无），与 NodeStatusInfoButton 内判据一致。
 */
const hasAbnormalStatus = computed(() => {
  const s = props.data.status
  return (
    s === NODE_GENERATION_STATUS.error ||
    s === NODE_GENERATION_STATUS.failed ||
    s === NODE_GENERATION_STATUS.fallback_pending
  )
})
const showStatusInfoButton = computed(
  () => hasAbnormalStatus.value && taskKind.value === 'generation' && Boolean(taskId.value),
)

function openEditor() {
  draft.value = String(props.data.content ?? '')
  editorOpen.value = true
}

function onSave(md: string) {
  if (patchCanvasNode && nodeId) {
    patchCanvasNode(nodeId, { content: md })
  } else {
    updateNodeData(nodeId, { content: md })
  }
}
</script>

<template>
  <NeoBaseNode node-type="text" :selected="selected" :data="data" :status="data.status">
    <div class="neo-text-card" title="双击打开沉浸编辑（全屏）" @dblclick.stop="openEditor">
      <p>{{ data.content || '双击编辑文本,或在下方 Dock 生成' }}</p>
      <NodeStatusInfoButton
        v-if="showStatusInfoButton"
        :status="data.status"
        :task-kind="taskKind"
        :task-id="taskId"
        :node-label="typeof data.label === 'string' ? data.label : undefined"
      />
      <NodeTaskCornerActions
        :status="data.status"
        :started-at="typeof data.generationStartedAt === 'string' ? data.generationStartedAt : undefined"
        :error-message="data.errorMessage as string | undefined"
        :error-code="data.errorCode as string | undefined"
        :task-kind="taskKind"
        :task-id="taskId"
        :node-label="typeof data.label === 'string' ? data.label : undefined"
        :session-id="sessionId"
        error-detail="status-icon"
      />
    </div>
    <PromptMarkdownEditor
      v-model:visible="editorOpen"
      v-model="draft"
      :title="typeof data.label === 'string' ? data.label : undefined"
      @save="onSave"
    />
  </NeoBaseNode>
</template>
