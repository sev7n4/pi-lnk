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

<style scoped>
/* 全屏查看器（D-B）：fixed 贴视口（2026-10-20 定位契约：fixed 而非 absolute 贴 100vh） */
.mobile-node-viewer {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
  background: var(--lnk-surface-canvas);
  box-sizing: border-box;
}

/* 顶部「返回画布」薄条：44px 热区 */
.viewer-back {
  display: inline-flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  flex: none;
  align-items: center;
  justify-content: center;
  margin: var(--lnk-space-1) 0 var(--lnk-space-2) var(--lnk-space-2);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-2xl);
  line-height: var(--lnk-lh-md);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.viewer-back:active {
  background: var(--lnk-pressed-overlay);
}

/* 灯箱媒体：contain 整图可见（不裁切），撑满返回条之外的剩余空间 */
.viewer-media {
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: contain;
}

/* 短文阅读器：可滚动 + 底部安全区留白 */
.viewer-reader {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--lnk-space-2) var(--lnk-space-4) calc(var(--lnk-space-4) + env(safe-area-inset-bottom));
  font-size: var(--lnk-text-base);
  line-height: var(--lnk-lh-base);
  color: var(--lnk-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
