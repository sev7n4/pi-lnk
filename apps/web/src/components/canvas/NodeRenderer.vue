<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
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
</script>

<template>
  <component :is="Target" v-bind="attrs" :id="id" :type="type" :data="data" />
</template>
