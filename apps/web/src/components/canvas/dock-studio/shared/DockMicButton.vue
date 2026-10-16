<script setup lang="ts">
import { computed, ref } from 'vue'
import { CANCEL_SWIPE_PX } from '@/components/agent/composer/holdGesture'

const props = defineProps<{
  listening?: boolean
  disabled?: boolean
  /** P2-2.1 press-and-hold 模式：press 开始、release 发送（转写填入不自动提交）、上滑取消。
   * 缺省 false = 既有点击开关行为（dock-studio 各面板沿用，零改动）。 */
  pressAndHold?: boolean
  /** is-listening 强化（P2-2.1）：录音时长（秒）与电平（0-1），press-and-hold 录音中展示 */
  durationSec?: number
  level?: number
}>()

const emit = defineEmits<{
  toggle: []
  holdstart: []
  holdend: []
  holdcancel: []
}>()

let holdPointerId: number | null = null
let pressStartY = 0
const swiping = ref(false) // 上滑已过取消阈值（视觉反馈 + release 分派）

const liveText = computed(() => {
  const s = props.durationSec ?? 0
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
const liveLevel = computed(() => Math.max(0.08, Math.min(1, props.level ?? 0)))

function onPointerDown(e: PointerEvent) {
  if (!props.pressAndHold || props.disabled) return
  pressStartY = e.clientY
  swiping.value = false
  holdPointerId = e.pointerId
  // 指针漂移/拖出按钮后仍能收到 move/up（release 不丢）
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 指针已释放等场景忽略 */
  }
  emit('holdstart')
}

function onPointerMove(e: PointerEvent) {
  if (holdPointerId === null) return
  swiping.value = e.clientY - pressStartY <= -CANCEL_SWIPE_PX
}

function onPointerUp(e: PointerEvent) {
  if (holdPointerId === null) return
  holdPointerId = null
  try {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  if (e.clientY - pressStartY <= -CANCEL_SWIPE_PX) emit('holdcancel')
  else emit('holdend')
}

function onPointerCancel() {
  if (holdPointerId === null) return
  holdPointerId = null
  swiping.value = false
  emit('holdcancel')
}

function onClick() {
  // press-and-hold 下 release 会派生 click，避免双触发 toggle
  if (!props.pressAndHold) emit('toggle')
}
</script>

<template>
  <button
    type="button"
    class="dock-mic-btn agent-hit-expand"
    data-hit="m"
    :class="{ 'is-listening': listening, 'is-cancel': swiping }"
    :title="listening && pressAndHold ? '松开结束 · 上滑取消' : '语音输入'"
    :aria-label="listening && pressAndHold ? '松开结束录音，上滑取消' : '语音输入'"
    :disabled="disabled"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @click="onClick"
  >
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="17" x2="12" y2="22" />
    </svg>
    <!-- P2-2.1 is-listening 强化：时长 + 电平条（浮标，不挤压 24px 图标位） -->
    <span v-if="listening && pressAndHold" class="dock-mic-live" aria-hidden="true">
      <span class="dock-mic-live__time">{{ liveText }}</span>
      <span class="dock-mic-live__track">
        <span class="dock-mic-live__level" :style="{ transform: `scaleX(${liveLevel})` }" />
      </span>
    </span>
  </button>
</template>

<style scoped>
.dock-mic-btn {
  display: inline-flex;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--neo-text-muted);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.dock-mic-btn:hover:not(:disabled) {
  background: var(--neo-hover-bg);
  color: var(--neo-text-primary);
}

.dock-mic-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.dock-mic-btn.is-listening {
  color: #f87171;
  animation: dock-mic-pulse 1.2s ease-in-out infinite;
}

/* P2-2.1 上滑取消反馈：与条级手势同色语义（红 = 放弃） */
.dock-mic-btn.is-cancel {
  color: var(--lnk-error);
  background: color-mix(in srgb, var(--lnk-error) 14%, transparent);
  animation: none;
}

/* P2-2 约束：prefers-reduced-motion 下不脉冲 */
@media (prefers-reduced-motion: reduce) {
  .dock-mic-btn.is-listening {
    animation: none;
  }
}

@keyframes dock-mic-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.dock-mic-live {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 999px;
  white-space: nowrap;
  background: var(--lnk-hi-bg);
  color: var(--lnk-hi-text);
  box-shadow: var(--lnk-shadow-sm);
  pointer-events: none;
  z-index: 5;
}

.dock-mic-live__time {
  font-size: var(--lnk-text-2xs);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.dock-mic-live__track {
  width: 28px;
  height: 3px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lnk-hi-text) 25%, transparent);
}

.dock-mic-live__level {
  display: block;
  width: 100%;
  height: 100%;
  transform-origin: left center;
  transform: scaleX(0.08);
  border-radius: inherit;
  background: var(--lnk-hi-text);
}
</style>
