<script setup lang="ts">
import { computed } from 'vue'
import type { TimelineAxis } from './useTimelineAxis'

/**
 * 时间刻度尺（P2.2）：按 axis 的 px/sec 生成固定间隔刻度，点击定位播放头。
 * 剪映范式：刻度尺与视频/音轨共享同一坐标系、同一滚动容器。
 */
const props = defineProps<{
  axis: TimelineAxis
  /** 刻度间隔（秒），缺省按总时长自适应取 1/2/5/10/30。 */
  tickSec?: number
}>()
const emit = defineEmits<{ seek: [sec: number] }>()

const stepSec = computed(() => {
  if (props.tickSec && props.tickSec > 0) return props.tickSec
  for (const s of [1, 2, 5, 10, 30, 60]) {
    if (props.axis.secToPx(s) >= 40) return s
  }
  return 60
})

const ticks = computed(() => {
  const out: number[] = []
  for (let sec = 0; sec <= props.axis.totalSec.value + 1e-6; sec += stepSec.value) out.push(sec)
  // 末尾补总时长刻度（即使不是整步），让「结束点」可见。
  const end = props.axis.totalSec.value
  if (end > 0 && Math.abs(end - out[out.length - 1]!) > 1e-6) out.push(end)
  return out
})

function mmss(sec: number) {
  const v = Math.max(0, Math.round(sec))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}
function onSeek(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // rect.left 已含滚动偏移：clientX - rect.left = 内容坐标 x
  emit('seek', props.axis.pxToSec(e.clientX - rect.left))
}
</script>

<template>
  <div
    class="tl-ruler"
    data-tl-ruler
    :style="{ width: `${axis.contentWidth.value}px` }"
    @click="onSeek"
  >
    <span
      v-for="sec in ticks"
      :key="sec"
      class="tl-ruler-tick"
      :style="{ left: `${axis.secToPx(sec)}px` }"
    >{{ mmss(sec) }}</span>
  </div>
</template>

<style scoped>
.tl-ruler {
  position: relative;
  height: 18px;
  cursor: pointer;
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.tl-ruler-tick {
  position: absolute;
  top: 0;
  font-size: var(--lnk-text-2xs);
  line-height: 18px;
  color: var(--lnk-text-secondary);
  transform: translateX(2px);
  white-space: nowrap;
}
</style>
