<script setup lang="ts">
import { computed, ref } from 'vue'
import anchorBadge from '@/assets/icons/anchor-badge.png'

/**
 * 滑动进入创作（2026-10-23 用户裁定「双入口」）：苹果滑动解锁的视觉语言——
 * 把手从左拖到右 = 寓意「从对话滑向画布」，松手过阈值即触发与锚**同一个** create
 * （签名画面页的双入口之二；原「描述你的创意」输入框退场，用户基本不在品牌页打字）。
 *
 * 设计约束：
 * - 坐在恒深签名底上 ⇒ 只消费 on-signature / stamp 家族令牌（主题不变式，
 *   与 SignatureHero 同一纪律：随主题翻转的 hi 对 / accent-text 禁入）。
 * - 触摸滚动：touch-action: pan-y —— 横向拖动归本组件，纵向滚动不被吞。
 * - 键盘可达：把手是真 <button>，Enter / 空格等效于滑满。
 * - reduced-motion：提示文字的流光停掉，拖拽/点击行为不受影响。
 *
 * 2026-10-24 性能修复：新增 `disabled` —— 创作进行中禁止再次触发
 * （否则会并发创建多个会话，用户以为没反应就反复滑）。
 */
const emit = defineEmits<{ create: [] }>()

const props = defineProps<{ disabled?: boolean }>()

const KNOB = 48 // 把手直径（px），与 CSS 保持一致
const TRACK_PADDING = 8 // 轨道左右内边距合计
const UNLOCK_RATIO = 0.72 // 松手解锁阈值（行程占比）

const trackEl = ref<HTMLElement | null>(null)
const knobX = ref(0)
const dragging = ref(false)
const unlocked = ref(false)
let pointerStartX = 0
let maxSpan = 240

function onPointerDown(e: PointerEvent) {
  if (unlocked.value || props.disabled) return
  dragging.value = true
  const width = trackEl.value?.clientWidth ?? 320
  maxSpan = Math.max(1, width - KNOB - TRACK_PADDING)
  pointerStartX = e.clientX - knobX.value
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  knobX.value = Math.min(maxSpan, Math.max(0, e.clientX - pointerStartX))
}

function onPointerUp() {
  if (!dragging.value) return
  dragging.value = false
  if (knobX.value >= maxSpan * UNLOCK_RATIO) {
    fire()
  } else {
    knobX.value = 0
  }
}

/**
 * 系统打断（来电 / 手势接管 / 触摸被取消）⇒ 回中位，**不触发** create。
 *
 * ⚠️ 2026-10-25 PR-0：此前 `pointercancel` 与 `pointerup` 共用同一处理器，
 *   于是「已拖过阈值时被系统打断」会被当成「用户松手确认」⇒ 莫名进创作。
 *   语义差别：pointerup 是用户**主动确认**；pointercancel 是手势被**系统接管**，
 *   用户从未表达"我要进" ⇒ 只能回中位。
 */
function onPointerCancel() {
  if (!dragging.value) return
  dragging.value = false
  knobX.value = 0
}

function fire() {
  if (unlocked.value || props.disabled) return
  unlocked.value = true
  knobX.value = maxSpan
  emit('create')
  // 归位延迟略长于 stamp 微时刻（600ms），两个入口的回弹节奏对齐
  window.setTimeout(() => {
    unlocked.value = false
    knobX.value = 0
  }, 650)
}

function onKeyDown(e: KeyboardEvent) {
  if (props.disabled) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    fire()
  }
}

const knobStyle = computed(() => ({ transform: `translateX(${knobX.value}px)` }))
const fillStyle = computed(() => ({
  width: `${Math.min(100, ((knobX.value + KNOB / 2) / Math.max(1, maxSpan + KNOB + TRACK_PADDING)) * 100)}%`,
  opacity: knobX.value > 0 ? '1' : '0',
}))
</script>

<template>
  <div
    ref="trackEl"
    class="lnk-slide"
    :class="{ 'lnk-slide--unlocked': unlocked, 'lnk-slide--disabled': disabled }"
    data-testid="slide-to-create"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
  >
    <span class="lnk-slide__fill" aria-hidden="true" :style="fillStyle" />
    <span class="lnk-slide__hint" aria-hidden="true">{{ disabled ? '正在进入画布…' : '滑动进入创作' }}</span>
    <p class="lnk-slide__sr-only">滑动进入创作：按住圆形把手向右拖到底后松手，或聚焦把手后按回车</p>
    <button
      type="button"
      class="lnk-slide__knob"
      :style="knobStyle"
      :disabled="disabled"
      aria-label="滑动进入创作"
      @keydown="onKeyDown"
    >
      <img
        class="lnk-slide__glyph"
        :src="anchorBadge"
        alt=""
        aria-hidden="true"
        draggable="false"
      >
    </button>
  </div>
</template>

<style scoped>
.lnk-slide {
  position: relative;
  display: flex;
  align-items: center;
  height: 64px;
  border-radius: 999px;
  /* 签名面「井」语言（与原输入容器同族）：恒深井 + on-signature 混色描边 */
  background: var(--lnk-surface-on-signature);
  border: 1px solid color-mix(in srgb, var(--lnk-text-on-signature) 14%, transparent);
  box-shadow:
    inset 0 1px 2px color-mix(in srgb, var(--lnk-ink-1000) 55%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--lnk-ink-1000) 30%, transparent);
  padding: 0 4px;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  cursor: grab;
}

.lnk-slide--unlocked {
  cursor: default;
}

/* 加载中（2026-10-24 性能修复）：禁二次触发。
   ⛔ 只用 on-signature 家族令牌（恒深签名底，主题不变式）。 */
.lnk-slide--disabled {
  cursor: progress;
  opacity: 0.72;
}

.lnk-slide--disabled .lnk-slide__knob {
  cursor: progress;
}

/* 拖动进度墨迹：accent 淡雾随把手推进（不抢锚的紫的唯一性，只做方向暗示） */
.lnk-slide__fill {
  position: absolute;
  left: 4px;
  top: 8px;
  bottom: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lnk-accent-subtle) 40%, transparent);
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}

.lnk-slide__hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-left: 44px; /* 视觉重心对轨道（把手占左侧 52px）居中 */
  font-size: var(--lnk-text-md);
  line-height: var(--lnk-lh-md);
  letter-spacing: 0.14em;
  color: transparent;
  background-image: linear-gradient(
    90deg,
    var(--lnk-text-on-signature-muted) 0%,
    var(--lnk-text-on-signature-muted) 42%,
    var(--lnk-text-on-signature) 50%,
    var(--lnk-text-on-signature-muted) 58%,
    var(--lnk-text-on-signature-muted) 100%
  );
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  animation: lnk-slide-shine 2.6s ease-in-out infinite;
  pointer-events: none;
}

.lnk-slide__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.lnk-slide__knob {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 999px;
  /* 印章盘面：与锚同材质（主题不变式），两个入口一眼同族 */
  background: var(--lnk-stamp-face-on-signature);
  color: var(--lnk-stamp-ink-on-signature);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--lnk-stamp-ink-on-signature) 20%, transparent),
    0 2px 10px color-mix(in srgb, var(--lnk-ink-1000) 45%, transparent);
  cursor: grab;
  transition: box-shadow 0.2s ease;
  /* 默认贴左；拖动时由 transform 承载位移（不参与 transition，跟手优先） */
  margin-right: auto;
}

.lnk-slide__knob:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 3px;
}

/* 把手 glyph = 双色徽标（2026-10-26 用户裁定④「解锁进创作图标：双色徽标」）。
   ⛔ 徽标**不能走 mask**：mask 会把黑盘/白锚压成单一 currentColor，丢掉双色——
      必须 <img> 原样出图（与画布落点标记 CanvasRefTargetIcon 同源同资产）。
   36px 在 48 把手里占 75%：徽标撑到只剩 ~6px 白圈边 ⇒ 读作「一枚徽章压在章面上」。
   ⚠️ 旧版 22px 只占 46%，白边 13px ⇒ 盘与徽标被读成**两个独立图标叠加**，
      且徽标本体只有 20px（用户实测「图标太小」）——放大到 36px 两个问题一起解。 */
.lnk-slide__glyph {
  display: block;
  width: 36px;
  height: 36px;
  object-fit: contain;
  pointer-events: none;
}

.lnk-slide--unlocked .lnk-slide__knob {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--lnk-stamp-ink-on-signature) 20%, transparent),
    0 0 24px color-mix(in srgb, var(--lnk-accent) 30%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .lnk-slide__hint {
    animation: none;
    color: var(--lnk-text-on-signature-muted);
    background-image: none;
    -webkit-background-clip: initial;
    background-clip: initial;
  }
}

@keyframes lnk-slide-shine {
  0% {
    background-position: 120% 0;
  }
  100% {
    background-position: -120% 0;
  }
}
</style>
