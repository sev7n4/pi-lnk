<script setup lang="ts">
/** 移动端画布「＋ FAB」（2026-10-19 D-2）：取代左侧竖轨的唯一新建入口。
 *  位置贴 dock/composer 之上（与 MobileMultiSelectBar 同一清位公式，
 *  复用运行时发布的 --lnk-agent-dock-h / --lnk-tabbar-h），不叠 z。
 *  空画布时呼吸微动效（设计 4.2）；48px 圆 + accent 渐变 + 白加号。 */
defineProps<{
  /** 空画布：呼吸微动效引导首建 */
  breathe?: boolean
}>()

const emit = defineEmits<{
  click: []
}>()
</script>

<template>
  <button
    type="button"
    class="mobile-create-fab"
    :class="{ 'is-breathing': breathe }"
    aria-label="新建节点"
    data-testid="mobile-create-fab"
    @click="emit('click')"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <path stroke-linecap="round" d="M12 5v14M5 12h14" />
    </svg>
  </button>
</template>

<style scoped>
.mobile-create-fab {
  position: absolute;
  left: 12px;
  bottom: calc(var(--lnk-agent-dock-h, 0px) + var(--lnk-tabbar-h, 0px) + env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 60;
  display: flex;
  width: 48px;
  height: 48px;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-accent-gradient);
  color: var(--lnk-text-on-accent);
  box-shadow: var(--lnk-shadow-md);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.mobile-create-fab:active {
  transform: scale(0.92);
}

.mobile-create-fab svg {
  width: 22px;
  height: 22px;
}

/* 空画布呼吸：2.4s 一轮，尊重系统减弱动效偏好 */
.mobile-create-fab.is-breathing {
  animation: fab-breathe 2.4s ease-in-out infinite;
}

@keyframes fab-breathe {
  0%,
  100% {
    box-shadow: var(--lnk-shadow-md), 0 0 0 0 color-mix(in srgb, var(--lnk-accent) 34%, transparent);
  }
  50% {
    box-shadow: var(--lnk-shadow-md), 0 0 0 8px color-mix(in srgb, var(--lnk-accent) 0%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mobile-create-fab.is-breathing {
    animation: none;
  }
}
</style>
