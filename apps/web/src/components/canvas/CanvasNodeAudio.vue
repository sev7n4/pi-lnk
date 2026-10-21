<script setup lang="ts">
import NeoBaseNode from '@/components/canvas/NeoBaseNode.vue'
import NodePendingPrompt from '@/components/canvas/NodePendingPrompt.vue'
import NodeTaskCornerActions from '@/components/canvas/NodeTaskCornerActions.vue'
import NodeStatusInfoButton from '@/components/canvas/NodeStatusInfoButton.vue'
import MediaInfoSummary from '@/components/media/MediaInfoSummary.vue'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { resolveMediaUrl } from '@/services/api-base'
import { useNodeMediaUpload } from '@/composables/useNodeMediaUpload'
import { useNodeMediaInfoFooter } from '@/composables/useNodeMediaInfoFooter'
import { useMediaInspector, type NodeMediaInfoSummary } from '@/composables/useMediaInspector'
import { NODE_GENERATION_STATUS, NODE_PENDING_CONFIRM_STATUS } from '@/constants/dockStudio'
import { downloadMediaFile, isUpstreamMediaUrl, mediaDownloadName, UPSTREAM_MEDIA_DOWNLOAD_HINT } from '@/composables/useCanvasMedia'
import { saveAssetToLibrary } from '@/composables/useAssetLibrary'
import { nodePlaceholderText } from '@/utils/incompleteNode'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    url?: string
    status: string
    uploadProgress?: number
    prompt?: string
    label?: string
    errorMessage?: string
    errorCode?: string
    generationStartedAt?: string
    generationRecordId?: string
    materialId?: string
    mediaInfo?: NodeMediaInfoSummary
  }
}>()

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
const { openInspector } = useMediaInspector()
const displayUrl = computed(() => resolveMediaUrl(String(props.data.url ?? '')))
const showInspectorBtn = computed(() => Boolean(props.data.generationRecordId))
const isCompleted = computed(() => props.data.status === NODE_GENERATION_STATUS.completed)
/** ADR-0011：待确认态（dock 已门控）⇒ 节点本体改渲染提示词摘要，不给上传入口 */
const isPendingConfirm = computed(() => props.data.status === NODE_PENDING_CONFIRM_STATUS)
const downloadTitle = computed(() =>
  isUpstreamMediaUrl(String(props.data.url ?? ''))
    ? UPSTREAM_MEDIA_DOWNLOAD_HINT
    : '下载音频',
)
const showMediaSummary = computed(() => Boolean(props.data.url && props.data.mediaInfo))
const { applyDurationSec } = useNodeMediaInfoFooter({
  nodeId: props.id,
  url: computed(() => props.data.url),
  kind: 'audio',
  mediaInfo: computed(() => props.data.mediaInfo),
})
const {
  accept,
  dragOver,
  rejectFlash,
  fileInput,
  openPicker,
  onFileChange,
  onDragOver,
  onDragLeave,
  onDrop,
} = useNodeMediaUpload(props.id, 'audio')

function onAudioLoadedMetadata(e: Event) {
  const el = e.target as HTMLAudioElement
  if (Number.isFinite(el.duration)) applyDurationSec(el.duration)
}

function download() {
  if (!displayUrl.value) return
  void downloadMediaFile(
    displayUrl.value,
    mediaDownloadName(displayUrl.value, 'audio', props.data.label ?? props.data.prompt),
    { sessionId: sessionId.value },
  )
}

function saveToLibrary() {
  const url = String(props.data.url ?? '').trim()
  if (!url) return
  void saveAssetToLibrary({
    kind: 'audio',
    url,
    label: props.data.label,
    prompt: props.data.prompt,
    sourceNodeId: props.id,
    sessionId: sessionId.value,
  })
}

function openMediaInspector(e?: Event) {
  e?.stopPropagation()
  e?.preventDefault()
  const recordId = props.data.generationRecordId
  if (!recordId) return
  void openInspector({
    generationRecordId: recordId,
    nodeId: props.id,
    nodeLabel: props.data.label ?? props.data.prompt,
    url: props.data.url,
    kind: 'audio',
  })
}
</script>

<template>
  <NeoBaseNode node-type="audio" :selected="selected" :data="data" :status="data.status">
    <template v-if="showMediaSummary && data.mediaInfo" #footer>
      <MediaInfoSummary v-bind="data.mediaInfo" />
    </template>
    <div
      class="neo-audio-card neo-node-upload-target"
      :class="{
        'is-drag-over': dragOver,
        'is-reject': rejectFlash,
      }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div v-if="data.url" class="relative">
        <audio
          :src="displayUrl"
          controls
          class="nodrag nowheel w-full"
          @loadedmetadata="onAudioLoadedMetadata"
        />
        <!-- hover 收敛（2026-10-12 用户口径）：有任务记录的节点 hover 只留 ⓘ，
             下载/存资产库统一进详情抽屉；无记录的本地上传节点保留原按钮兜底
             （此时抽屉不可达，否则功能无处可去） -->
        <button
          v-if="!showInspectorBtn"
          type="button"
          class="neo-node-replace-btn nodrag"
          title="替换音频"
          @pointerdown.stop
          @mousedown.stop
          @click.stop="openPicker"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
        <button
          v-if="!showInspectorBtn"
          type="button"
          class="neo-node-download-btn nodrag"
          :title="downloadTitle"
          @pointerdown.stop
          @mousedown.stop
          @click.stop="download"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        <button
          v-if="!showInspectorBtn"
          type="button"
          class="neo-node-save-btn nodrag"
          title="存入资产库"
          @pointerdown.stop
          @mousedown.stop
          @click.stop="saveToLibrary"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <button
          v-if="showInspectorBtn"
          type="button"
          class="neo-media-inspector-btn nodrag"
          :class="{ 'is-completed': isCompleted }"
          aria-label="媒体属性"
          title="媒体属性"
          @pointerdown.stop
          @mousedown.stop
          @click.stop="openMediaInspector"
        >
          ⓘ
        </button>
      </div>
      <div
        v-else
        class="neo-node-placeholder"
        :class="{
          'is-generating': data.status === 'generating',
          'is-uploading': data.status === 'uploading',
          'is-failed': data.status === 'failed' || data.status === 'error',
        }"
      >
        <div class="neo-placeholder-content">
          <!-- ADR-0011 决定 1：待确认态渲染提示词摘要（dock 已对该态门控） -->
          <NodePendingPrompt :prompt="data.prompt" :label="data.label" :status="data.status" />
          <template v-if="!isPendingConfirm">
            <button
              v-if="data.status !== 'generating' && data.status !== 'uploading'"
              type="button"
              class="neo-node-upload-btn nodrag"
              title="上传音频"
              @pointerdown.stop
              @mousedown.stop
              @click.stop="openPicker"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
            <span class="neo-placeholder-text">
              {{
                data.status === 'uploading'
                  ? `上传中 ${data.uploadProgress ?? 0}%`
                  : nodePlaceholderText(data.status)
              }}
            </span>
          </template>
          <NodeStatusInfoButton
            v-if="showInspectorBtn"
            :status="data.status"
            :task-kind="taskKind"
            :task-id="taskId"
            :node-label="typeof data.label === 'string' ? data.label : undefined"
            @inspect="openMediaInspector()"
          />
          <div v-if="data.status === 'uploading'" class="neo-upload-progress">
            <div class="neo-upload-progress-bar" :style="{ width: `${data.uploadProgress ?? 0}%` }" />
          </div>
        </div>
      </div>
      <!-- prompt 文本卡（2026-10-12 删）：音频是唯一有媒体后仍显示 prompt 的节点，
           与图片/视频不对齐且挤占卡片；prompt 统一在详情抽屉查看 -->
      <input
        ref="fileInput"
        type="file"
        :accept="accept"
        class="nodrag hidden"
        @click.stop
        @change="onFileChange"
      >
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
  </NeoBaseNode>
</template>
