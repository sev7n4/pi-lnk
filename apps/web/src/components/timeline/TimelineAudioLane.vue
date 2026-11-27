<script setup lang="ts">
import { computed } from 'vue'
import type { TimelineTrack } from '@lnkpi/shared'
import { useNodeWaveform, decodeChannelWithWebAudio } from '@/composables/useNodeWaveform'
import MobileNodeWaveform from '@/components/mobile/MobileNodeWaveform.vue'
import type { TimelineAxis } from './useTimelineAxis'

/**
 * A1/A2 单条音轨（P2.2）：复用仓库既有 useNodeWaveform + MobileNodeWaveform，
 * 真实 peaks 解码失败时保持占位 + loading 微标，绝不编造数据（规格 §3 波形特例）。
 */
const props = defineProps<{
  axis: TimelineAxis
  index: 0 | 1
  tracks: TimelineTrack[]
}>()

const laneTracks = computed(() => props.tracks.filter((x) => x.audioTrackIndex === props.index))

/** 每条音轨取第一个片段的 url 解码波形；多片段各自裁剪显示同一素材的 peaks 段。 */
const firstUrl = computed(() => laneTracks.value[0]?.url)
const { peaks, source, loading } = useNodeWaveform({
  nodeId: () => laneTracks.value[0]?.nodeId,
  url: () => firstUrl.value,
  decoder: decodeChannelWithWebAudio,
})

function mmss(sec: number) {
  const v = Math.max(0, Math.round(sec))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}
</script>

<template>
  <div class="tl-audio-row" :data-tl-audio-row="index">
    <span class="tl-audio-label">A{{ index + 1 }}</span>
    <div class="tl-audio-lane" :style="{ width: `${axis.contentWidth.value}px` }">
      <div
        v-for="track in laneTracks"
        :key="track.nodeId"
        class="tl-audio-clip"
        data-tl-audio-clip
        :data-node-id="track.nodeId"
        :title="`${track.title} · ${mmss(track.startSec)}`"
        :style="{
          left: `${axis.secToPx(track.startSec)}px`,
          width: `${Math.max(8, axis.secToPx(track.durationSec))}px`,
        }"
      >
        <MobileNodeWaveform :peaks="peaks" :source="source" :loading="loading" />
        <span class="tl-audio-clip-title">{{ track.title }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tl-audio-row { display: flex; align-items: center; gap: 6px; height: 34px; }
.tl-audio-label { width: 18px; flex: none; font-size: var(--lnk-text-2xs); color: var(--lnk-text-secondary); }
.tl-audio-lane { position: relative; height: 28px; border-radius: 4px; background: var(--lnk-surface-sunken); }
.tl-audio-clip {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 4px;
  background: var(--lnk-accent-subtle);
  overflow: hidden;
}
.tl-audio-clip :deep(.mobile-node-waveform) { height: 100%; }
.tl-audio-clip-title {
  position: absolute;
  inset: 2px 4px auto;
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
</style>
