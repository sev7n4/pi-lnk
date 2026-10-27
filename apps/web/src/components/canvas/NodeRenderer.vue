<script setup lang="ts">
import { computed, inject, useAttrs } from 'vue'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
import {
  MOBILE_NODE_OPEN_VIEWER_KEY,
  MOBILE_NODE_TOGGLE_SELECT_KEY,
  type MobileNodeToggleSelectFn,
  isViewableNodeType,
  MOBILE_NODE_OPEN_EDITOR_KEY,
  CANVAS_NODE_RETRY_KEY,
  type MobileNodeOpenViewerFn,
  type MobileNodeOpenEditorFn,
  type CanvasNodeRetryFn,
} from '@/composables/canvasNodeActions'
import { resolveMobileNodeTapIntent } from '@/composables/mobileNodeOpenPolicy'
import CanvasNodeImage from './CanvasNodeImage.vue'
import CanvasNodeVideo from './CanvasNodeVideo.vue'
import CanvasNodeAudio from './CanvasNodeAudio.vue'
import CanvasNodeText from './CanvasNodeText.vue'
import MobileNodeTile from '@/components/mobile/MobileNodeTile.vue'

const props = defineProps<{
  id: string
  type: 'image' | 'video' | 'audio' | 'text'
  data?: any
}>()

const attrs = useAttrs()
const { isMobileLayout } = useAgentMobileLayout()

const legacy: Record<string, any> = {
  image: CanvasNodeImage,
  video: CanvasNodeVideo,
  audio: CanvasNodeAudio,
  text: CanvasNodeText,
}

const Target = computed(() =>
  isMobileLayout.value ? MobileNodeTile : (legacy[props.type] as any),
)

// 移动端 tap / open-reader → 打开全屏查看器（图灯箱/视频播放/文本阅读器）；
// 由 CanvasPage 经注入键承接，避免组件树深处的节点直接依赖画布壳层。
const openViewer = inject<MobileNodeOpenViewerFn>(MOBILE_NODE_OPEN_VIEWER_KEY, () => {})
// R2-T2：空节点 tap → 编辑 sheet（不再开空白全屏）。
const openEditor = inject<MobileNodeOpenEditorFn>(MOBILE_NODE_OPEN_EDITOR_KEY, () => {})

/**
 * tap 意图由纯函数单一判定（审阅焦点 #2：策略不在三处各写一遍）。
 * - viewer：有产物的图/视/文（pending / confirmed / 失败但有旧产物）→ 全屏查看器
 * - editor：编辑 sheet（编辑器入口改走长按 Menu；单击不进编辑器）
 * - inline：音频 → 磁贴内联播放（不进本函数）
 * - none：空 / 生成中 / 失败且无旧产物 → 无 op（轻提示由磁贴给出，不开任何全屏层）
 *
 * ⭐ D1/D3（2026-10-25 规格 §5.1 · 铁律 P1「单击 = 查看」）：'none' 必须
 *   **既不开 viewer 也不开 editor**——否则空节点又回到 R2 的「空白全屏」症状。
 */
function onTileOpen() {
  const node = { id: props.id, type: props.type, data: props.data }
  const intent = resolveMobileNodeTapIntent(node)
  if (intent === 'viewer') {
    // D2 修订（2026-10-27）：audio 回归可查看（波形查看器）⇒ 守卫只拦未知类型
    if (isViewableNodeType(node.type)) {
      openViewer({ id: node.id, type: node.type, data: node.data })
    }
    return
  }
  if (intent === 'editor') {
    openEditor(node)
    return
  }
  // 'none'：无 op + 轻提示（提示由 MobileNodeTile 给出）——不开 viewer / editor
}

/**
 * R3-T3：失败态磁贴的「重试」→ 复用桌面同一注入键 `CANVAS_NODE_RETRY_KEY`
 * （桌面角标 `NodeTaskCornerActions` 走的也是它）⇒ ⛔ 不新建重试通路，
 * 移动端与桌面共用同一套重试语义（换模型重试等 overrides 也自动可用）。
 */
const retryNode = inject<CanvasNodeRetryFn | null>(CANVAS_NODE_RETRY_KEY, null)
function onTileRetry() {
  if (!retryNode) return
  void retryNode(props.id)
}

/**
 * D4 / H1（§4.9 选择模式）：磁贴在选择模式下轻点 = 切换选中（不开查看器）。
 * ⭐ 走注入键由 CanvasPage 承接（与 tap / retry 同款分层，⛔ 不让磁贴直接依赖壳层）。
 */
const toggleSelectNode = inject<MobileNodeToggleSelectFn>(MOBILE_NODE_TOGGLE_SELECT_KEY, () => {})
function onTileToggleSelect() {
  toggleSelectNode(props.id)
}
</script>

<template>
  <component
    :is="Target"
    v-bind="attrs"
    :id="id"
    :type="type"
    :data="data"
    @tap="onTileOpen"
    @open-reader="onTileOpen"
    @retry="onTileRetry"
    @toggle-select="onTileToggleSelect"
  />
</template>
