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
    /** 三轮 R10（2026-11-19）：关闭手势开关，默认开（HIG bottom sheet 下滑即关）。
     *  对话框型 sheet（有必选动作/表单未保存）可传 false 关闭此手势，避免误关。 */
    swipeToDismiss?: boolean
    /** 2026-11-20 模型选择卡：可选返回按钮（sheet 内二级页 push/pop）。
     *  缺省 false——存量 8+ 调用点零变化；仅模型配置页传 true。 */
    showBack?: boolean
  }>(),
  { maxHeight: '62vh', swipeToDismiss: true, showBack: false },
)

const emit = defineEmits<{
  close: []
  back: []
}>()

/** R10：下拉关闭手势——起点 y、是否从滚动顶部起手势、 dragging 态。
 *  判据：仅当手势起点落在「未滚动的内容顶部」(scrollTop<=1) 且下落位移 > 阈值(80px) 才关闭，
 *  从列表中段下拉仍是滚动，不误关。touchstart 用 passive:false 以便必要时 preventDefault 抑制回弹。 */
const DISMISS_THRESHOLD_PX = 80
const bodyRef = ref<HTMLElement | null>(null)
const dragOffset = ref(0)
let startY = 0
let lastDy = 0
let startAtTop = false
let dragging = false

function onTouchStart(e: TouchEvent) {
  if (e.touches.length !== 1) return
  startY = e.touches[0]!.clientY
  lastDy = 0
  startAtTop = (bodyRef.value?.scrollTop ?? 0) <= 1
  dragging = false
}

function onTouchMove(e: TouchEvent) {
  if (e.touches.length !== 1 || !startAtTop) return
  lastDy = e.touches[0]!.clientY - startY
  if (lastDy <= 0) {
    dragOffset.value = 0
    dragging = false
    return
  }
  dragging = true
  dragOffset.value = lastDy
  if (lastDy > DISMISS_THRESHOLD_PX && e.cancelable) e.preventDefault()
}

function onTouchEnd() {
  const shouldDismiss = dragging && startAtTop && lastDy > DISMISS_THRESHOLD_PX
  dragOffset.value = 0
  dragging = false
  startY = 0
  lastDy = 0
  if (shouldDismiss) dismiss()
}

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
        <div
          class="m-sheet"
          role="dialog"
          :aria-label="title"
          :style="{ maxHeight, ...(dragOffset ? { transform: `translateY(${dragOffset}px)` } : {}) }"
          @touchstart.passive="swipeToDismiss && onTouchStart($event)"
          @touchmove="swipeToDismiss && onTouchMove($event)"
          @touchend.passive="swipeToDismiss && onTouchEnd()"
          @touchcancel.passive="swipeToDismiss && onTouchEnd()"
        >
          <div class="m-sheet-handle" data-testid="m-sheet-handle" aria-hidden="true" />
          <header class="m-sheet-head">
            <button
              v-if="showBack"
              type="button"
              class="m-sheet-back"
              aria-label="返回"
              data-testid="m-sheet-back"
              @click="emit('back')"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div class="min-w-0">
              <p class="m-sheet-title">{{ title }}</p>
              <p v-if="subtitle" class="m-sheet-subtitle">{{ subtitle }}</p>
            </div>
            <!-- 二级操作插槽（模型选择卡的设置齿轮）；缺省为空 ⇒ 存量调用点无差异 -->
            <slot name="headerActions" />
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
          <div class="m-sheet-body" ref="bodyRef">
            <slot />
          </div>
          <!--
            底部主栏 slot（2026-10-25 D8/J1/K1 + L1/M1 引入）：
            承载「唯一主动作」按钮（如轻量编辑器的「发给 agent 修改」、标注浮层的
            「⚓ 带回对话」）—— 与内容区分离 ⇒ 内容可滚、动作恒在拇指区（§4.11.6）。
            ⭐ 可选 slot：未提供时底部不占位。
          -->
          <div v-if="$slots.actions" class="m-sheet-actions">
            <slot name="actions" />
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
  z-index: var(--lnk-z-modal);
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
  /* ⭐ 圆角用令牌（禁硬编码 20px，§4.11.8） */
  border-radius: var(--lnk-radius-2xl) var(--lnk-radius-2xl) 0 0;
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

/* 返回按钮：与 close 同尺寸/同令牌，仅 showBack 时渲染（iOS 二级页 push/pop） */
.m-sheet-back {
  display: flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  flex: none;
  align-items: center;
  justify-content: center;
  margin: -6px -4px 0 -8px;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-muted);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background var(--lnk-duration-fast) ease;
}

.m-sheet-back:active {
  background: var(--lnk-pressed-overlay);
}

.m-sheet-back svg {
  width: 16px;
  height: 16px;
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

/* 底部主栏：动作恒在拇指区，内容区独立滚动（§4.11.6 可达性） */
.m-sheet-actions {
  flex: none;
  padding: var(--lnk-space-3) var(--lnk-space-3)
    calc(var(--lnk-space-3) + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--lnk-border-subtle);
}

.m-sheet-body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

/* ⭐ 动效用令牌（禁硬编码 0.25s + 自定义曲线，§4.11.8） */
.m-sheet-enter-active,
.m-sheet-leave-active {
  transition: opacity var(--lnk-duration-base) var(--lnk-ease-decelerate);
}

.m-sheet-enter-active .m-sheet,
.m-sheet-leave-active .m-sheet {
  transition: transform var(--lnk-duration-base) var(--lnk-ease-decelerate);
}

/* ⭐ 尊重「减弱动态效果」（Apple HIG · Reduce Motion / §4.11.8）——
   仓库既有先例：neo-node.css:651、LoginVideoPanel.vue:182 */
@media (prefers-reduced-motion: reduce) {
  .m-sheet-enter-active,
  .m-sheet-leave-active,
  .m-sheet-enter-active .m-sheet,
  .m-sheet-leave-active .m-sheet {
    transition: none;
  }
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
