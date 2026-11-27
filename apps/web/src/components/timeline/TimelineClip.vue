<script setup lang="ts">
import { computed } from 'vue'
import { clipDurationSec, type TimelineTrack } from '@lnkpi/shared'
import type { TimelineAxis } from './useTimelineAxis'

/**
 * 视觉片段块（P2.2）：选中态白框 + 两端 trim 手柄（剪映范式）。
 * 定位在内容坐标系：left = 累计秒 * pxPerSec，width = clipDurationSec * pxPerSec。
 */
const props = defineProps<{
  axis: TimelineAxis
  track: TimelineTrack
  /** 在当前视觉轨中的起始秒（累计前面片段时长）。 */
  startSec: number
  index: number
  selected?: boolean
}>()
const emit = defineEmits<{
  select: [nodeId: string]
  trim: [payload: { nodeId: string; edge: 'in' | 'out'; deltaSec: number }]
}>()

const widthPx = computed(() => Math.max(8, props.axis.secToPx(clipDurationSec(props.track))))
const leftPx = computed(() => `${props.axis.secToPx(props.startSec)}px`)

function mmss(sec: number) {
  const v = Math.max(0, Math.round(sec))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}
</script>

<template>
  <div
    class="tl-clip"
    :class="{ 'is-selected': selected }"
    data-tl-clip
    :data-node-id="track.nodeId"
    :style="{ left: leftPx, width: `${widthPx}px` }"
    :title="`${index + 1}. ${track.title} · ${mmss(clipDurationSec(track))}`"
    @click.stop="emit('select', track.nodeId)"
  >
    <span class="tl-clip-title">{{ index + 1 }}. {{ track.title }}</span>
    <span
      class="tl-clip-handle tl-clip-handle--in"
      data-tl-trim-in
      title="裁剪入点"
      @pointerdown.stop
      @click.stop="emit('trim', { nodeId: track.nodeId, edge: 'in', deltaSec: 0.5 })"
    />
    <span
      class="tl-clip-handle tl-clip-handle--out"
      data-tl-trim-out
      title="裁剪出点"
      @pointerdown.stop
      @click.stop="emit('trim', { nodeId: track.nodeId, edge: 'out', deltaSec: -0.5 })"
    />
  </div>
</template>

<style scoped>
.tl-clip {
  position: absolute;
  top: 0;
  height: 100%;
  border-right: 1px solid var(--lnk-border-subtle);
  background: var(--lnk-accent-subtle);
  color: var(--lnk-text-primary);
  cursor: pointer;
  overflow: hidden;
}
.tl-clip.is-selected { outline: 2px solid var(--lnk-accent-text); outline-offset: -2px; }
.tl-clip-title {
  position: absolute;
  inset: 4px 8px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-clip-handle {
  position: absolute;
  top: 0;
  width: 6px;
  height: 100%;
  background: var(--lnk-border-strong);
  cursor: ew-resize;
  opacity: 0;
}
.tl-clip.is-selected .tl-clip-handle { opacity: 1; }
.tl-clip-handle--in { left: 0; }
.tl-clip-handle--out { right: 0; }
</style>
