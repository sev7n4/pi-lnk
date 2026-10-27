<script setup lang="ts">
/**
 * 删除撤销提示（D5 / §4.11.10，2026-10-27 S2 批次从 `CanvasPage.vue` 抽出）：
 * 底部浮层 + 单一「撤销」action（MD3 R5.16：限一个 action）。
 *
 * ⭐ 抽组件动机（V-7 撤销端到端断言）：原 toast 长在 6500 行的 `CanvasPage.vue`
 *   模板里，页面级挂载测试不可行（vue-flow 全家桶）⇒ V-7「点撤销 ⇒ 节点恢复」
 *   只能靠**静态源契约**（假绿风险）。抽成组件后：
 *   ① 组件层**行为断言**（渲染 / 点击 emit action / role+aria）；
 *   ② 页面层保留**接线静态契约**（`@action="undoLastDelete"` + undo 调用）；
 *   ③ composable 层已有「undo 恢复快照」行为断言（`useCanvasUndoStack.test.ts`）
 *   —— 三层合起来构成 V-7 的端到端等价链。
 *
 * 展示性组件：不持状态、不管计时（`showUndoToast` / 5s 窗口留在页面层——
 * 它与删除动作的调用点耦合，抽走反而制造第二个真源）。
 */
defineProps<{
  message: string
}>()

const emit = defineEmits<{
  (e: 'action'): void
}>()
</script>

<template>
  <div
    class="mobile-undo-toast"
    role="status"
    aria-live="polite"
    data-testid="mobile-undo-toast"
  >
    <span class="mobile-undo-toast-text">{{ message }}</span>
    <button
      type="button"
      class="mobile-undo-toast-action"
      data-testid="mobile-undo-toast-action"
      @click="emit('action')"
    >撤销</button>
  </div>
</template>

<style scoped>
.mobile-undo-toast {
  position: fixed;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 88px);
  z-index: 4000;
  display: flex;
  align-items: center;
  gap: var(--lnk-space-3);
  transform: translateX(-50%);
  max-width: min(420px, calc(100% - 24px));
  padding: var(--lnk-space-2) var(--lnk-space-2) var(--lnk-space-2) var(--lnk-space-4);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-raised);
  box-shadow: var(--lnk-shadow-lg);
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-medium);
  color: var(--lnk-text-primary);
  white-space: nowrap;
  animation: mobile-undo-toast-in 160ms ease-out;
}

/* ⭐ V-6：reduce-motion 下不做入场动画（内容立即呈现） */
@media (prefers-reduced-motion: reduce) {
  .mobile-undo-toast {
    animation: none;
  }
}

.mobile-undo-toast-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 单一 action（MD3 R5.16：限一个 action） */
.mobile-undo-toast-action {
  flex: none;
  min-height: 32px;
  padding: 0 var(--lnk-space-3);
  border: none;
  border-radius: var(--lnk-radius-full);
  background: transparent;
  color: var(--lnk-accent);
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-semibold);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

@keyframes mobile-undo-toast-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}
</style>
