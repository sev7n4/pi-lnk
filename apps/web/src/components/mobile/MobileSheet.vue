<script setup lang="ts">
/** 移动端全宽底部 sheet 基座（2026-10-19 D-2 新建收敛）：
 *  遮罩 + 拖拽把手 + 标题 + 250ms 减速曲线，与 PR1 上下文动作 sheet
 *  （CanvasContextMenu.vue 移动端分支）同一表面语言；PR5 壳层重构时
 *  将该处也收敛到本基座，消灭第二份实现。
 *  消费 L2 令牌（--lnk-surface-raised / --lnk-scrim / --lnk-shadow-lg）。
 *  位置 fixed + Teleport body：画布区有 transform，fixed 会被困住。 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** sheet 最大高度（CSS 长度），默认 62vh——新建宫格 10 项 + 资产库瓦片 */
    maxHeight?: string
  }>(),
  { maxHeight: '62vh' },
)

const emit = defineEmits<{
  close: []
}>()

/** 进场后锁 body 滚动，避免 sheet 内滚动带动画布（iOS 需 overflow:hidden + touch-action） */
const bodyOverflow = ref('')
onMounted(() => {
  bodyOverflow.value = document.body.style.overflow
  document.body.style.overflow = 'hidden'
})
onBeforeUnmount(() => {
  document.body.style.overflow = bodyOverflow.value
})

function dismiss() {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="m-sheet">
      <div class="m-sheet-root">
        <div class="m-sheet-scrim" data-testid="m-sheet-scrim" @click="dismiss" />
        <div class="m-sheet" role="dialog" :aria-label="title" :style="{ maxHeight }">
          <div class="m-sheet-handle" aria-hidden="true" />
          <header class="m-sheet-head">
            <div class="min-w-0">
              <p class="m-sheet-title">{{ title }}</p>
              <p v-if="subtitle" class="m-sheet-subtitle">{{ subtitle }}</p>
            </div>
            <button
              type="button"
              class="m-sheet-close"
              aria-label="关闭"
              data-testid="m-sheet-close"
              @click="dismiss"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>
          <div class="m-sheet-body">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.m-sheet-root {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.m-sheet-scrim {
  position: absolute;
  inset: 0;
  background: var(--lnk-scrim);
}

.m-sheet {
  position: relative;
  display: flex;
  width: 100%;
  flex-direction: column;
  overflow: hidden;
  padding: 0 var(--lnk-space-3) calc(var(--lnk-space-3) + env(safe-area-inset-bottom, 0px));
  border-radius: 20px 20px 0 0;
  background: var(--lnk-surface-raised);
  box-shadow: var(--lnk-shadow-lg);
}

.m-sheet-handle {
  width: 40px;
  height: 4px;
  flex: none;
  margin: 8px auto 2px;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-border-strong);
}

.m-sheet-head {
  display: flex;
  flex: none;
  align-items: flex-start;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-1) var(--lnk-space-1) var(--lnk-space-2);
}

.m-sheet-title {
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
  line-height: var(--lnk-lh-md);
}

.m-sheet-subtitle {
  margin-top: 2px;
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
  line-height: var(--lnk-lh-2xs);
}

.m-sheet-close {
  display: flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  flex: none;
  align-items: center;
  justify-content: center;
  margin: -6px -8px 0 0;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-muted);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background var(--lnk-duration-fast) ease;
}

.m-sheet-close:active {
  background: var(--lnk-pressed-overlay);
}

.m-sheet-close svg {
  width: 16px;
  height: 16px;
}

.m-sheet-body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.m-sheet-enter-active,
.m-sheet-leave-active {
  transition: opacity 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}

.m-sheet-enter-active .m-sheet,
.m-sheet-leave-active .m-sheet {
  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}

.m-sheet-enter-from,
.m-sheet-leave-to {
  opacity: 0;
}

.m-sheet-enter-from .m-sheet,
.m-sheet-leave-to .m-sheet {
  transform: translateY(24px);
}
</style>
