<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '@/services/api'
import { worksApi } from '@/services/works-api'
import { resolveMediaUrl } from '@/services/api-base'
import { useCanvasEditorStore } from '@/stores/canvasEditor'
import MediaPreviewOverlay from '@/components/canvas/MediaPreviewOverlay.vue'
import CanvasLocateButton from '@/components/shared/CanvasLocateButton.vue'

const props = defineProps<{
  modelValue: boolean
  sessionId?: string
  sessions?: Array<{ id: string; title: string }>
  defaultTitle?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  published: []
  'locate-node': [payload: { sessionId: string; nodeId: string }]
}>()

interface PrimaryNodeOption {
  id: string
  type: 'image' | 'video'
  label: string
  preview: string
}

const editor = useCanvasEditorStore()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const title = ref('')
// 2026-10-21 P1：原 `category` 是「分类下拉」，随分类口径切type 维度后
// 下拉失去意义（分类已由 type 决定）。字段语义改为「可选合集名」自由文本，
// 故连变量名一起改，避免旧语义留在代码里误导下一个人。
const seriesName = ref('')
const selectedSessionId = ref('')
const primaryNodeId = ref('')
const primaryNodes = ref<PrimaryNodeOption[]>([])
const loadingNodes = ref(false)
const loading = ref(false)
const error = ref('')
const success = ref(false)

const activeSessionId = computed(() => props.sessionId ?? selectedSessionId.value)
const canSubmit = computed(() => !!title.value.trim() && !!activeSessionId.value && !!primaryNodeId.value)

async function loadPrimaryNodes(sid: string) {
  if (!sid) {
    primaryNodes.value = []
    primaryNodeId.value = ''
    return
  }
  loadingNodes.value = true
  try {
    const { data } = await api.get<{ data: { canvasData?: { nodes?: Array<{ id: string; type?: string; data?: { url?: string; coverUrl?: string } }> } } }>(
      `/sessions/${sid}`,
    )
    primaryNodes.value = (data.data.canvasData?.nodes ?? [])
      .filter((n) => (n.type === 'image' || n.type === 'video') && n.data?.url)
      .map((n) => ({
        id: n.id,
        type: n.type as 'image' | 'video',
        label: `${n.id} · ${n.type === 'video' ? '视频' : '图片'}`,
        preview: resolveMediaUrl(n.data?.coverUrl || n.data?.url || ''),
      }))
    if (!primaryNodes.value.some((n) => n.id === primaryNodeId.value)) {
      primaryNodeId.value = primaryNodes.value[0]?.id ?? ''
    }
  } catch {
    primaryNodes.value = []
    primaryNodeId.value = ''
  } finally {
    loadingNodes.value = false
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      title.value = props.defaultTitle ?? '未命名作品'
      seriesName.value = ''
      selectedSessionId.value = props.sessionId ?? props.sessions?.[0]?.id ?? ''
      error.value = ''
      success.value = false
      void loadPrimaryNodes(activeSessionId.value)
    }
  },
)

watch(activeSessionId, (sid) => {
  if (props.modelValue) void loadPrimaryNodes(sid)
})

function previewNode(node: PrimaryNodeOption, e: Event) {
  e.preventDefault()
  e.stopPropagation()
  if (!node.preview) return
  editor.openMediaPreview({
    url: node.preview,
    kind: node.type === 'video' ? 'video' : 'image',
    label: node.label,
  })
}

function locateNode(node: PrimaryNodeOption, e: Event) {
  e.preventDefault()
  e.stopPropagation()
  const sid = activeSessionId.value
  if (!sid) return
  emit('locate-node', { sessionId: sid, nodeId: node.id })
}

async function handlePublish() {
  const sid = activeSessionId.value
  if (!canSubmit.value || !sid) return
  loading.value = true
  error.value = ''
  try {
    await worksApi.publish({
      sessionId: sid,
      title: title.value.trim(),
      // 关键：空串必须转 undefined —— DTO 里 category?: string 可选，
      // 但 '' ≠未传；直接传 '' 会给作品留一个空合集名，后续按 category
      // 非空做系列分组时会误命中。undefined 才能让整个键在序列化时消失。
      category: seriesName.value.trim() || undefined,
      primaryNodeId: primaryNodeId.value,
    })
    success.value = true
    emit('published')
    setTimeout(() => { visible.value = false }, 1200)
  } catch {
    error.value = '发布失败，请确认已登录、已选择主成片且画布有效'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="发布到超创站"
    width="480px"
    class="publish-dialog"
    destroy-on-close
  >
    <div v-if="success" class="py-8 text-center">
      <p class="text-lg text-fg-accent">发布成功 🎉</p>
      <p class="mt-2 text-sm text-fg-3">作品已出现在社区作品流</p>
    </div>
    <form v-else class="space-y-4" @submit.prevent="handlePublish">
      <div v-if="!sessionId && sessions?.length">
        <label class="mb-1 block text-xs text-fg-3">选择画布</label>
        <el-select v-model="selectedSessionId" class="w-full">
          <el-option
            v-for="s in sessions"
            :key="s.id"
            :label="s.title"
            :value="s.id"
          />
        </el-select>
      </div>
      <div>
        <label class="mb-1 block text-xs text-fg-3">作品标题</label>
        <el-input v-model="title" placeholder="输入作品标题" />
      </div>
      <div>
        <label class="mb-1 block text-xs text-fg-3">合集名（可选）</label>
        <el-input v-model="seriesName" placeholder="留空则不归入合集" maxlength="40" />
      </div>
      <div>
        <label class="mb-1 block text-xs text-fg-3">主成片节点 <span class="text-danger">*</span></label>
        <div v-if="loadingNodes" class="py-4 text-center text-sm text-fg-3">加载节点中…</div>
        <div v-else-if="!primaryNodes.length" class="rounded-lg border border-dashed border-overlay/10 p-4 text-sm text-fg-3">
          当前画布没有可发布的图片/视频节点，请先生成或上传媒体
        </div>
        <el-radio-group v-else v-model="primaryNodeId" class="flex w-full flex-col gap-2">
          <el-radio
            v-for="node in primaryNodes"
            :key="node.id"
            :value="node.id"
            class="primary-node-radio !mr-0 !h-auto w-full rounded-lg border border-overlay/8 bg-overlay/[0.03] px-3 py-2"
          >
            <div class="flex w-full min-w-0 items-center gap-3">
              <video
                v-if="node.type === 'video'"
                :src="node.preview"
                muted
                playsinline
                preload="metadata"
                class="h-10 w-16 shrink-0 rounded object-cover bg-black/40"
              />
              <img
                v-else
                :src="node.preview"
                :alt="node.label"
                class="h-10 w-16 shrink-0 rounded object-cover"
              />
              <span class="min-w-0 flex-1 truncate text-sm">{{ node.label }}</span>
              <div class="flex shrink-0 items-center gap-1" @click.stop>
                <button
                  type="button"
                  class="rounded-md px-2 py-1 text-[11px] text-fg-3 transition hover:bg-overlay/10 hover:text-fg"
                  title="预览"
                  @click="previewNode(node, $event)"
                >
                  预览
                </button>
                <CanvasLocateButton
                  title="定位到画布"
                  @click="(e) => locateNode(node, e)"
                />
              </div>
            </div>
          </el-radio>
        </el-radio-group>
      </div>
      <p v-if="error" class="text-sm text-danger">{{ error }}</p>
      <div class="flex justify-end gap-2 pt-2">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="loading" :disabled="!canSubmit" native-type="submit">发布</el-button>
      </div>
    </form>
  </el-dialog>
  <MediaPreviewOverlay />
</template>

<style>
.publish-dialog .el-dialog {
  background: var(--lnk-surface-overlay);
  border: 1px solid rgb(var(--lnk-overlay-rgb) / 0.08);
}
.publish-dialog .el-dialog__title {
  color: var(--lnk-text-primary);
}
.publish-dialog .primary-node-radio .el-radio__label {
  width: 100%;
  padding-left: 8px;
}
</style>
