<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TimelineAxis } from './useTimelineAxis'

/**
 * 贯穿刻度/视频/音轨的播放头竖线（P2.2，剪映范式）。
 * 定位在内容坐标系（left = sec * pxPerSec），与轨道共享滚动容器 ⇒ 横滑不错位。
 * pointerdown/move/up 拖动，6px 内吸附可选边缘（片段边界/剪辑点）。
 */
const props = defineProps<{
  axis: TimelineAxis
  sec: number
  /** 吸附候选（秒）：由宿主传入片段起止点；不传则不吸附。 */
  snapEdges?: number[]
  /** 竖线覆盖的总高度（px），由宿主按轨道区高度传入。 */
  height?: number
}>()
const emit = defineEmits<{ seek: [sec: number] }>()

const dragging = ref(false)
const leftPx = computed(() => `${props.axis.secToPx(props.sec)}px`)

function commitClientX(clientX: number, target: HTMLElement) {
  const rect = target.getBoundingClientRect()
  // 播放头挂在内容层；target 是内容层容器时 rect.left 已含滚动偏移。
  const raw = props.axis.pxToSec(clientX - rect.left)
  const clamped = Math.min(props.axis.totalSec.value, Math.max(0, raw))
  emit('seek', props.snapEdges?.length ? props.axis.snapSec(clamped, props.snapEdges) : clamped)
}

function onPointerDown(e: PointerEvent) {
  dragging.value = true
  const layer = (e.currentTarget as HTMLElement).parentElement!
  layer.setPointerCapture?.(e.pointerId)
  commitClientX(e.clientX, layer)
}
function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const layer = (e.currentTarget as HTMLElement).parentElement!
  commitClientX(e.clientX, layer)
}
function onPointerUp(e: PointerEvent) {
  dragging.value = false
  const layer = (e.currentTarget as HTMLElement).parentElement!
  layer.releasePointerCapture?.(e.pointerId)
}
</script>

<template>
  <div
    class="tl-playhead"
    data-tl-playhead
    :class="{ 'is-dragging': dragging }"
    :style="{ left: leftPx, height: `${height ?? 100}%` }"
    role="slider"
    :aria-valuenow="sec"
    aria-valuemin="0"
    :aria-valuemax="axis.totalSec.value"
    aria-label="播放头"
    tabindex="0"
    @pointerdown.stop="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <span class="tl-playhead-handle" aria-hidden="true" />
  </div>
</template>

<style scoped>
.tl-playhead {
  position: absolute;
  top: 0;
  width: 2px;
  z-index: 6;
  background: var(--lnk-accent-text);
  cursor: ew-resize;
  touch-action: none;
}
.tl-playhead.is-dragging { width: 3px; }
.tl-playhead-handle {
  position: absolute;
  top: -2px;
  left: -4px;
  width: 10px;
  height: 10px;
  background: var(--lnk-accent-text);
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}
</style>
