<script setup lang="ts">
import { computed } from 'vue'
import { nodeTypeConfigs } from './nodeTypeConfigs'

const props = defineProps<{
  type: 'image' | 'video' | 'audio' | 'text'
  data?: { url?: string; poster?: string; content?: string }
  status?: string
}>()

const emit = defineEmits<{ (e: 'tap'): void }>()

const cfg = computed(() => nodeTypeConfigs[props.type])
const badge = computed(() => cfg.value.statusBadge(props.status))
</script>

<template>
  <div class="mobile-node-tile" :data-type="type" @click="emit('tap')">
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
      <button class="mobile-audio-play" type="button" aria-label="播放">▶</button>
    </div>
    <p v-else-if="type === 'text'" class="mobile-node-text">{{ data?.content || '空文本' }}</p>

    <span v-if="badge" class="mobile-node-badge" :data-tone="badge.tone">{{ badge.label }}</span>
  </div>
</template>
