<script setup lang="ts">
import { computed, inject, useAttrs } from 'vue'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
import {
  MOBILE_NODE_OPEN_VIEWER_KEY,
  MOBILE_NODE_OPEN_EDITOR_KEY,
  type MobileNodeOpenViewerFn,
  type MobileNodeOpenEditorFn,
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
 * - viewer：有内容的图/视/文 → 全屏查看器
 * - editor：空节点（无 url / 无内容）→ 编辑 sheet（D-C 状态机 empty 行）
 * - inline：有音频的音频节点 → 磁贴内联播放（不进本函数）
 */
function onTileOpen() {
  const node = { id: props.id, type: props.type, data: props.data }
  if (resolveMobileNodeTapIntent(node) === 'editor') {
    openEditor(node)
    return
  }
  openViewer(node)
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
  />
</template>
