<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useLongPress } from '@/composables/useLongPress'
import {
  MOBILE_NODE_ACTION_REQUEST_KEY,
  CANVAS_NODE_CLICK_GUARD_KEY,
  type MobileNodeActionRequestFn,
  type CanvasNodeClickGuard,
} from '@/composables/canvasNodeActions'
import { useTextToSpeech } from '@/composables/useTextToSpeech'
import { nodeTypeConfigs } from './nodeTypeConfigs'

/** 文本节点：超过该字数的 tap 走 TTS 朗读，否则开阅读器（D-A，R1-T6） */
const TTS_THRESHOLD = 120

const props = defineProps<{
  id?: string
  type: 'image' | 'video' | 'audio' | 'text'
  data?: { url?: string; poster?: string; content?: string }
  status?: string
}>()

const emit = defineEmits<{ (e: 'tap'): void; (e: 'open-reader'): void }>()
const tts = useTextToSpeech()

const cfg = computed(() => nodeTypeConfigs[props.type])
const badge = computed(() => cfg.value.statusBadge(props.status))

const mobileActionRequest = inject<MobileNodeActionRequestFn>(MOBILE_NODE_ACTION_REQUEST_KEY, () => {})
const clickGuard = inject<CanvasNodeClickGuard>(CANVAS_NODE_CLICK_GUARD_KEY, {
  shouldSuppress: () => false,
  markSuppressed: () => {},
})

const { bindings } = useLongPress(() => {
  const id = props.id
  if (id && mobileActionRequest) {
    mobileActionRequest({ id, type: props.type, data: props.data })
  }
})

const audioEl = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
function toggleAudio() {
  const el = audioEl.value
  if (!el) return
  if (playing.value) {
    el.pause()
    playing.value = false
    return
  }
  playing.value = true
  try {
    const p = el.play() as Promise<void> | undefined
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {
    /* jsdom 无媒体实现，忽略 */
  }
}

function onTileClick() {
  if (props.type === 'audio') {
    toggleAudio()
    return
  }
  if (props.type === 'text') {
    handleTextTap()
    return
  }
  if (clickGuard?.shouldSuppress?.()) return
  emit('tap')
}

/** 文本范式反转（D-A）：长文朗读、短文开阅读器；主动作不再"打开节点详情" */
function handleTextTap() {
  const content = props.data?.content ?? ''
  if (content.length > TTS_THRESHOLD) {
    tts.speak(content)
  } else {
    emit('open-reader')
  }
}
</script>

<template>
  <div
    class="mobile-node-tile"
    :data-type="type"
    :data-playing="playing ? 'true' : undefined"
    @click="onTileClick"
    @touchstart="bindings.onTouchstart"
    @touchmove="bindings.onTouchmove"
    @touchend="bindings.onTouchend"
    @touchcancel="bindings.onTouchcancel"
  >
    <img
      v-if="type === 'image' && data?.url"
      :src="data.url"
      class="mobile-node-media"
      alt=""
    />
    <video
      v-else-if="type === 'video'"
      :src="data?.url"
      :poster="data?.poster"
      preload="none"
      muted
      playsinline
      class="mobile-node-media"
    />
    <div v-else-if="type === 'audio'" class="mobile-audio-wave" role="img" aria-label="音频波形占位">
      <button class="mobile-audio-play" type="button" :aria-label="playing ? '暂停' : '播放'" @click.stop="toggleAudio">▶</button>
      <audio ref="audioEl" :src="data?.url" />
    </div>
    <p v-else-if="type === 'text'" class="mobile-node-text">{{ data?.content || '空文本' }}</p>

    <span v-if="badge" class="mobile-node-badge" :data-tone="badge.tone">{{ badge.label }}</span>
  </div>
</template>
