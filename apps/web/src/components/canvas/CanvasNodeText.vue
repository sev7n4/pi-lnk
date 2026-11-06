<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useNodeId, useVueFlow } from '@vue-flow/core'
import NeoBaseNode from '@/components/canvas/NeoBaseNode.vue'
import NodeTaskCornerActions from '@/components/canvas/NodeTaskCornerActions.vue'
import NodeStatusInfoButton from '@/components/canvas/NodeStatusInfoButton.vue'
import PromptMarkdownEditor from '@/components/canvas/PromptMarkdownEditor.vue'
import HtmlNodePreview from '@/components/canvas/HtmlNodePreview.vue'
import { CANVAS_NODE_PATCH_KEY, CANVAS_NODE_READONLY_KEY } from '@/composables/canvasNodeActions'
import { htmlNodeSummary, resolveTextNodeFormat } from '@lnkpi/shared'
import { NODE_GENERATION_STATUS } from '@/constants/dockStudio'

const props = defineProps<{
  selected?: boolean
  data: {
    content: string
    label?: string
    format?: string
    status?: string
    errorMessage?: string
    errorCode?: string
    generationStartedAt?: string
    generationRecordId?: string
    materialId?: string
    /** 受信级 CSP 分流判据（§5.2）：仅系统 digest 管道写入 'system-digest'。 */
    source?: string
    /** Task 7：系统总览节点标记（finalizeTurn upsert 打入）⇒ 只读分支。 */
    digest?: boolean
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
  // Task 7：digest 只读（脏数据 format 丢失时走 plain 分支也不能编辑）
  if (isDigest.value) return
  draft.value = String(props.data.content ?? '')
  editorOpen.value = true
}

function onSave(md: string) {
  // Task 7：与 openEditor 双保险——即便编辑器被外部触发，写回也必须拦住
  if (isDigest.value) return
  if (patchCanvasNode && nodeId) {
    patchCanvasNode(nodeId, { content: md })
  } else {
    updateNodeData(nodeId, { content: md })
  }
}

const readonlyPage = inject(CANVAS_NODE_READONLY_KEY, false)
const isHtml = computed(() => resolveTextNodeFormat(props.data.format) === 'html')
// Task 7（spec 2026-11-05-canvas-digest §10 风险#1）：系统总览节点禁编辑——
// 用户改动会被下轮 finalizeTurn 翻新覆盖，预览强制 readonly。
const isDigest = computed(() => props.data.digest === true)
const htmlSummary = computed(() => htmlNodeSummary(props.data as Record<string, unknown>))
const previewOpen = ref(false)

function openHtmlPreview() {
  if (readonlyPage) return
  previewOpen.value = true
}

// 规格 §5.4：emit save → 宿主 patch 通路；patchCanvasNode 缺席（无 patch 通道的宿主）
// 不落 updateNodeData fallback——预览本就不该在只读宿主打开（openHtmlPreview 已拦）。
function onHtmlSave(payload: { content: string; format: 'html' }) {
  if (isDigest.value) return // digest 翻新会覆盖用户编辑 ⇒ 系统节点不可写（双保险）
  if (patchCanvasNode && nodeId) {
    patchCanvasNode(nodeId, { content: payload.content, format: payload.format })
  }
  previewOpen.value = false
}
</script>

<template>
  <NeoBaseNode node-type="text" :selected="selected" :data="data" :status="data.status">
    <div
      v-if="isHtml"
      class="neo-text-card neo-text-card--html"
      title="双击打开 HTML 沙箱预览"
      @dblclick.stop="openHtmlPreview"
    >
      <span class="neo-html-badge">{{ isDigest ? '总览' : 'HTML' }}</span>
      <p class="neo-html-summary">{{ htmlSummary || 'HTML 产物' }}</p>
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
    <div v-else class="neo-text-card" title="双击打开沉浸编辑（全屏）" @dblclick.stop="openEditor">
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
    <HtmlNodePreview
      v-if="previewOpen"
      :content="String(data.content ?? '')"
      :trusted="String(data.source ?? '') === 'system-digest'"
      :readonly="isDigest"
      @save="onHtmlSave"
      @close="previewOpen = false"
    />
  </NeoBaseNode>
</template>
