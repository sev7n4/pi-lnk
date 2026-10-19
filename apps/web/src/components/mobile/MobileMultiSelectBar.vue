<script setup lang="ts">
/**
 * 移动端多选态动作条（2026-10-19 D-4 / S3）。
 * PR1 骨架：已选 N + 完成（退出）。PR3 在其上补「批量生成 / 停止 / 更多 ⋯」。
 * 位置贴 dock/composer 之上（沿用 --lnk-agent-dock-h 清位公式），不叠 z。
 */
defineProps<{
  count: number
}>()

const emit = defineEmits<{
  done: []
}>()
</script>

<template>
  <div class="mobile-multi-select-bar" data-testid="mobile-multi-select-bar">
    <span class="msb-count">已选 {{ count }}</span>
    <button
      type="button"
      class="msb-done"
      data-testid="mobile-multi-select-done"
      @click="emit('done')"
    >
      完成
    </button>
  </div>
</template>

<style scoped>
.mobile-multi-select-bar {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(var(--lnk-agent-dock-h, 0px) + var(--lnk-tabbar-h, 0px) + env(safe-area-inset-bottom, 0px) + 12px);
  z-index: 55;
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 16px;
  border-radius: 9999px;
  background: var(--lnk-surface-overlay);
  border: 0.5px solid var(--lnk-border-subtle);
  box-shadow: var(--lnk-shadow-md);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}

.msb-count {
  font-size: var(--lnk-text-sm);
  font-weight: 500;
  color: var(--lnk-text-secondary);
  font-variant-numeric: tabular-nums;
}

.msb-done {
  display: flex;
  min-width: 64px;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  border: none;
  border-radius: 9999px;
  background: var(--lnk-accent-gradient);
  color: var(--lnk-text-on-accent);
  font-size: var(--lnk-text-sm);
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.12s ease;
}

.msb-done:active {
  transform: scale(0.94);
}
</style>
