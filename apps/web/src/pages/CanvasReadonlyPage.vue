<script setup lang="ts">
import { computed, nextTick, onMounted, provide, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VueFlow, type Edge, type Node } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { ElMessage } from 'element-plus'
import type { Work } from '@lnkpi/shared'
import { worksApi } from '@/services/works-api'
import { useAuthStore } from '@/stores/auth'
import CanvasNodePrompt from '@/components/canvas/CanvasNodePrompt.vue'
import CanvasNodeImage from '@/components/canvas/CanvasNodeImage.vue'
import CanvasNodeVideo from '@/components/canvas/CanvasNodeVideo.vue'
import CanvasNodeText from '@/components/canvas/CanvasNodeText.vue'
import CanvasNodeAudio from '@/components/canvas/CanvasNodeAudio.vue'
import { CANVAS_NODE_READONLY_KEY } from '@/composables/canvasNodeActions'
import { computeContentViewport } from '@/composables/useCanvasViewport'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// 只读页（规格 §9 #12 v3 升级）：无 patch 通道，必须关死编辑/预览入口，
// 防 updateNodeData fallback 静默假写（§5.4）。
provide(CANVAS_NODE_READONLY_KEY, true)

const workId = computed(() => route.params.id as string)
const work = ref<Work | null>(null)
const nodes = ref<Node[]>([])
const edges = ref<Edge[]>([])
const loading = ref(true)
const forking = ref(false)
const vueFlowRef = ref<InstanceType<typeof VueFlow> | null>(null)

const nodeTypes = {
  prompt: CanvasNodePrompt,
  image: CanvasNodeImage,
  video: CanvasNodeVideo,
  text: CanvasNodeText,
  audio: CanvasNodeAudio,
}

onMounted(async () => {
  try {
    const [workRes, canvasRes] = await Promise.all([
      worksApi.get(workId.value),
      worksApi.getCanvas(workId.value),
    ])
    work.value = workRes.data.data
    nodes.value = (canvasRes.data.data.nodes ?? []) as Node[]
    edges.value = (canvasRes.data.data.edges ?? []) as Edge[]
    // 不用 VueFlow 的 init 自动全览：它对全部节点（含千万级离群）fitView，zoom 被压到 minZoom 0.1、
    // 真实内容推出屏幕外（与 CanvasPage 同源故障）。等 nodes 应用完再确定性落位。
    await nextTick()
    fitContentViewport()
  } catch {
    work.value = null
  } finally {
    loading.value = false
  }
})

/** 只读页首屏全览：按非离群节点包围盒确定性算视口（不依赖 fitView 的节点测量盒）。 */
function fitContentViewport() {
  const el = document.querySelector('.canvas-flow') as HTMLElement | null
  const safeViewport = computeContentViewport(
    nodes.value,
    el?.clientWidth ?? window.innerWidth,
    el?.clientHeight ?? window.innerHeight,
  )
  if (!safeViewport) return
  const flow = vueFlowRef.value as {
    setViewport?: (vp: { x: number; y: number; zoom: number }, opts?: { duration?: number }) => void
  } | null
  flow?.setViewport?.(safeViewport, { duration: 0 })
}

async function forkToMyCanvas() {
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  forking.value = true
  try {
    const { data } = await worksApi.forkCanvas(workId.value)
    ElMessage.success('已复制到你的项目')
    router.push(`/workflow/${data.data.id}`)
  } catch {
    ElMessage.error('复制失败，请确认已登录')
  } finally {
    forking.value = false
  }
}

function backToShare() {
  router.push(`/share/${workId.value}`)
}
</script>

<template>
  <div class="flex h-[calc(100vh-4rem)] flex-col">
    <div class="flex items-center justify-between border-b border-overlay/8 bg-surface-canvas px-4 py-3">
      <div class="flex items-center gap-3">
        <button class="text-sm text-fg-3 hover:text-fg" @click="backToShare">← 返回详情</button>
        <span class="rounded-md bg-warning-bg px-2 py-0.5 text-xs text-warning">只读 · 制作过程</span>
        <span v-if="work" class="text-sm text-fg-2">{{ work.title }}</span>
      </div>
      <button class="btn-primary text-sm" :disabled="forking" @click="forkToMyCanvas">
        {{ forking ? '复制中…' : '复制到我的项目' }}
      </button>
    </div>

    <div v-if="loading" class="flex flex-1 items-center justify-center text-fg-3">加载中…</div>
    <div v-else-if="!work" class="flex flex-1 items-center justify-center text-fg-3">作品不存在</div>
    <div v-else class="relative flex-1">
      <VueFlow
        ref="vueFlowRef"
        :nodes="nodes"
        :edges="edges"
        :node-types="nodeTypes as any"
        :nodes-draggable="false"
        :nodes-connectable="false"
        :elements-selectable="false"
        :pan-on-drag="true"
        :zoom-on-scroll="true"
        class="canvas-flow h-full w-full bg-surface-sunken"
      >
        <Background pattern-color="#333" :gap="20" />
      </VueFlow>
    </div>
  </div>
</template>

<style scoped>
.canvas-flow :deep(.vue-flow__pane) {
  cursor: grab;
}

/* Block node edit chrome (upload/replace/save/edit/rename) while keeping pan/zoom on the pane */
.canvas-flow :deep(.vue-flow__node) {
  pointer-events: none;
}
</style>
