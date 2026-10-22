<script setup lang="ts">
defineProps<{
  type: 'image' | 'video' | 'audio' | 'text'
  data?: { url?: string; poster?: string; content?: string }
}>()

const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div class="mobile-node-viewer" role="dialog" aria-modal="true">
    <button class="viewer-back" type="button" aria-label="返回画布" @click="emit('close')">‹</button>
    <img v-if="type === 'image' && data?.url" :src="data.url" class="viewer-media" alt="" />
    <video v-else-if="type === 'video'" :src="data?.url" controls class="viewer-media" />
    <div v-else-if="type === 'text'" class="viewer-reader">{{ data?.content }}</div>
  </div>
</template>
