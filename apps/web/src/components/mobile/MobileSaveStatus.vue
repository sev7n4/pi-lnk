<script setup lang="ts">
/**
 * 移动端画布自动保存状态行（2026-10-20 PR4 / I-8 引入；
 * 2026-10-21 用户裁决改版：**静默成功，只报异常**）。
 *
 * 移动端画布是自动保存（每次编辑都 PUT），「已保存 HH:mm」常驻胶囊是对
 * 确定性成功的自我确认——没有行动价值，常驻只制造噪音并挤占 ＋FAB 同一
 * 清位带 ⇒ 改为异常态才现身：
 * - 保存中：仅一枚呼吸圆点（瞬态，随保存完成消失），不出文字胶囊；
 * - 保存失败：红色「未保存 · 点按重试」胶囊常驻，点按触发一次手动保存
 *   （原「点按手动存」能力保留在失败重试里，不再占成功态一位）；
 * - 成功态：零渲染。
 */
import { computed } from 'vue'

const props = defineProps<{
  saving: boolean
  /** 最近一次自动保存是否失败（成功落库后由 CanvasPage 清位） */
  failed?: boolean
}>()

const emit = defineEmits<{
  save: []
}>()

const visible = computed(() => props.failed || props.saving)
</script>

<template>
  <button
    v-if="visible"
    type="button"
    class="mobile-save-status"
    :class="failed ? 'is-failed' : 'is-saving'"
    data-testid="mobile-save-status"
    :aria-label="failed ? '画布保存失败，点按重试' : '保存中'"
    :disabled="!failed"
    @click="failed && emit('save')"
  >
    <span class="mss-dot" aria-hidden="true" />
    <span v-if="failed" class="mss-label">未保存 · 点按重试</span>
  </button>
</template>

<style scoped>
.mobile-save-status {
  /* ⚠️ fixed（**不是** absolute）：同 ＋FAB——absolute 贴 100vh 根容器底边，在带浏览器
     工具条的真机上整颗掉出可见区。fixed 贴可见视口底，与页签栏同一坐标系。 */
  position: fixed;
  /* 横向让开 ＋FAB：68px = FAB 12 + 48 + 8 间距（同带不同位，FAB(z60) 不压本行(z54)） */
  left: 68px;
  /* +10px = (FAB 48 − 胶囊 28) / 2 ⇒ 与 ＋FAB 垂直居中 */
  bottom: calc(var(--lnk-agent-dock-h, 0px) + var(--lnk-tabbar-h, 0px) + env(safe-area-inset-bottom, 0px) + 12px + 10px);
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
  /* 保存中的呼吸点不可交互：去掉胶囊壳，只留一枚点（PR 后极简形态） */
  cursor: default;
  border-color: transparent;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  padding: 0;
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
}

/* 失败态：红色胶囊（语义色 + 可点重试） */
.mobile-save-status.is-failed {
  border-color: color-mix(in srgb, var(--lnk-error) 45%, transparent);
  background: color-mix(in srgb, var(--lnk-error) 12%, var(--lnk-surface-overlay));
  color: var(--lnk-error);
}

.mss-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-success);
}

/* 保存中：琥珀呼吸点（瞬态） */
.mobile-save-status.is-saving .mss-dot {
  background: var(--lnk-warning);
  animation: mss-pulse 1.1s ease-in-out infinite;
}

/* 失败：红点 */
.mobile-save-status.is-failed .mss-dot {
  background: var(--lnk-error);
}

.mss-label {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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
