<script setup lang="ts">
/**
 * 移动端画布自动保存状态行（2026-10-20 PR4 / I-8）。
 *
 * 移动端画布早已是自动保存（每次编辑都 PUT），「保存画布」菜单项是 PC 手动心智
 * 的遗留 ⇒ 从顶栏 ⋯ 菜单移除，改由本行如实告知「保存中 / 上次保存 HH:mm」。
 * 点按仍可手动触发一次保存（不删能力，只是不再占菜单一位）。
 */
import { computed } from 'vue'

const props = defineProps<{
  saving: boolean
  /** 上次保存完成时间（毫秒时间戳）；null = 本次会话还没存过 */
  savedAt?: number | null
}>()

const emit = defineEmits<{
  save: []
}>()

const label = computed(() => {
  if (props.saving) return '保存中…'
  if (!props.savedAt) return '尚未保存'
  const d = new Date(props.savedAt)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `已保存 ${hh}:${mm}`
})
</script>

<template>
  <button
    type="button"
    class="mobile-save-status"
    :class="{ 'is-saving': saving }"
    data-testid="mobile-save-status"
    :aria-label="label"
    :disabled="saving"
    @click="emit('save')"
  >
    <span class="mss-dot" aria-hidden="true" />
    <span class="mss-label">{{ label }}</span>
  </button>
</template>

<style scoped>
.mobile-save-status {
  position: absolute;
  left: 12px;
  bottom: calc(var(--lnk-agent-dock-h, 0px) + var(--lnk-tabbar-h, 0px) + env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 54;
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-2xs);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.mobile-save-status:active {
  transform: scale(0.96);
}

.mobile-save-status:disabled {
  cursor: default;
}

.mss-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-success);
}

.mobile-save-status.is-saving .mss-dot {
  background: var(--lnk-warning);
  animation: mss-pulse 1.1s ease-in-out infinite;
}

.mss-label {
  font-variant-numeric: tabular-nums;
}

@keyframes mss-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mobile-save-status.is-saving .mss-dot {
    animation: none;
  }
}
</style>
