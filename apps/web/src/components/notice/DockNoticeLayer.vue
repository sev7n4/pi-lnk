<script setup lang="ts">
import { useDockNoticeStore, type DockNotice, type DockNoticeTone } from '@/stores/dockNotice'

const store = useDockNoticeStore()

const TONE_META: Record<DockNoticeTone, { icon: string; label: string }> = {
  error: { icon: '✕', label: '错误' },
  warning: { icon: '!', label: '警告' },
  info: { icon: 'i', label: '提示' },
  success: { icon: '✓', label: '成功' },
  ad: { icon: '★', label: '推荐' },
}

function onAction(n: DockNotice) {
  if (n.action?.onClick) n.action.onClick()
  else if (n.action?.href) window.open(n.action.href, '_blank')
  store.dismiss(n.id)
}

function onClose(n: DockNotice) {
  store.dismiss(n.id)
}
</script>

<template>
  <Teleport to="body">
    <div class="dock-notice-layer" aria-live="polite">
      <TransitionGroup name="dock-notice">
        <div
          v-for="n in store.notices"
          :key="n.id"
          class="dock-notice-card"
          :class="`tone-${n.tone}`"
          role="status"
        >
          <span class="dock-notice-accent" aria-hidden="true" />
          <div v-if="n.image" class="dock-notice-media">
            <img :src="n.image" alt="" />
          </div>
          <div class="dock-notice-body">
            <div class="dock-notice-head">
              <span class="dock-notice-icon">{{ TONE_META[n.tone].icon }}</span>
              <span class="dock-notice-title">{{ n.title }}</span>
              <button class="dock-notice-close" type="button" aria-label="关闭" @click="onClose(n)">
                ×
              </button>
            </div>
            <p class="dock-notice-msg">{{ n.message }}</p>
            <button
              v-if="n.action"
              class="dock-notice-action"
              type="button"
              @click="onAction(n)"
            >
              {{ n.action.label }}
            </button>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.dock-notice-layer {
  position: fixed;
  left: 50%;
  bottom: 96px; /* dock 上沿：dockStudioReserve(80) + 间距 */
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(360px, calc(100vw - 32px));
  z-index: 60;
  pointer-events: none; /* 不挡画布操作，卡片本身恢复可点 */
}

.dock-notice-card {
  pointer-events: auto;
  position: relative;
  display: flex;
  background: #ffffff;
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(17, 24, 39, 0.16);
  overflow: hidden;
  color: #1f2329;
}

.dock-notice-accent {
  flex: 0 0 4px;
  background: var(--notice-accent, #3b82f6);
}

.dock-notice-media {
  flex: 0 0 84px;
}
.dock-notice-media img {
  width: 84px;
  height: 100%;
  object-fit: cover;
  display: block;
}

.dock-notice-body {
  flex: 1 1 auto;
  min-width: 0;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dock-notice-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dock-notice-icon {
  flex: 0 0 20px;
  height: 20px;
  width: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--lnk-text-on-accent);
  background: var(--notice-accent, #3b82f6);
}

.dock-notice-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  color: #1f2329;
}

.dock-notice-close {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: #8a9099;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  border-radius: 6px;
}
.dock-notice-close:hover {
  color: #1f2329;
  background: rgba(17, 24, 39, 0.06);
}

.dock-notice-msg {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: #5b6168;
  word-break: break-word;
}

.dock-notice-action {
  align-self: flex-start;
  margin-top: 2px;
  border: none;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  color: var(--lnk-text-on-accent);
  background: var(--notice-accent, #3b82f6);
}
.dock-notice-action:hover {
  filter: brightness(0.95);
}

/* tone 配色（浅色主题：浅底深字 + 彩色强调条/图标） */
.tone-error {
  --notice-accent: #e5484d;
}
.tone-warning {
  --notice-accent: #f5a623;
}
.tone-info {
  --notice-accent: #3b82f6;
}
.tone-success {
  --notice-accent: #30a46c;
}
.tone-ad {
  --notice-accent: #7c5cff;
}

/* 从 dock 上沿滑入 + 淡入 */
.dock-notice-enter-from {
  opacity: 0;
  transform: translateY(18px) scale(0.98);
}
.dock-notice-enter-active,
.dock-notice-leave-active {
  transition: opacity 0.28s ease, transform 0.28s ease;
}
.dock-notice-leave-to {
  opacity: 0;
  transform: translateY(18px) scale(0.98);
}
.dock-notice-leave-active {
  position: absolute;
  width: 100%;
}
</style>
