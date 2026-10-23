<script setup lang="ts">
import { computed, inject, useAttrs } from 'vue'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
import { MOBILE_NODE_OPEN_VIEWER_KEY, type MobileNodeOpenViewerFn } from '@/composables/canvasNodeActions'
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
function onTileOpen() {
  openViewer({ id: props.id, type: props.type, data: props.data })
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
