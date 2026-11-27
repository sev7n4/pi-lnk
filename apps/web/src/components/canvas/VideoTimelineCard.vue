<script setup lang="ts">
import { computed } from 'vue'
import { clipDurationSec, type TimelineTrack, type VideoTimeline } from '@lnkpi/shared'

const props = defineProps<{
  nodeId: string
  timeline: VideoTimeline
  status: string
  renderEnabled: boolean
  /** 竖屏（9:16 等）由节点外框比例决定；true 时片段块纵向堆叠，避免横线挤压。 */
  portrait?: boolean
}>()

const emit = defineEmits<{
  'request-render': []
  'request-edit': []
  'request-play': [payload: { url: string; title: string; estimated: boolean }]
}>()

const visualTracks = computed(() => {
  const order = new Map(props.timeline.trackOrder.map((id, i) => [id, i]))
  return props.timeline.tracks
    .filter((t) => t.type === 'video' || t.type === 'image')
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
})

const audioTracks = computed(() => props.timeline.tracks.filter((t) => t.type === 'audio'))

// 与编译器/visualDurationSec 同一时长真相源：裁剪后不读 durationSec 原值。
const totalSec = computed(() => visualTracks.value.reduce((sum, t) => sum + clipDurationSec(t), 0))

// 播放源取 track.url（create 时从上游分镜节点复制的真实 url），只播 video 类型，禁造占位 url。
const playableTrack = computed(() => visualTracks.value.find((t) => t.type === 'video' && t.url))

function requestPlay() {
  const track = playableTrack.value
  if (!track) return
  emit('request-play', {
    url: track.url,
    title: track.title,
    estimated: Boolean(track.durationEstimated),
  })
}

function mmss(sec: number) {
  const value = Math.max(0, Math.round(sec))
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

function widthPct(track: TimelineTrack) {
  return totalSec.value ? `${(clipDurationSec(track) / totalSec.value) * 100}%` : '0%'
}

function playTitle() {
  const track = playableTrack.value
  if (!track) return ''
  return `播放 ${track.title}${track.durationEstimated ? '（时长待实测）' : ''}`
}

function leftPct(sec: number) {
  return totalSec.value ? `${Math.min(100, (sec / totalSec.value) * 100)}%` : '0%'
}

function exportTitle() {
  if (!props.renderEnabled) return '渲染未启用：需服务端开启渲染能力并扩容后使用'
  if (props.status === 'queued' || props.status === 'rendering') return '正在渲染，请稍候'
  return '渲染成片'
}

function requestRender() {
  if (!props.renderEnabled || props.status === 'queued' || props.status === 'rendering') return
  emit('request-render')
}
</script>

<template>
  <section class="vt-card nodrag" :class="{ 'vt-card--portrait': portrait }">
    <header class="vt-card__header">
      <span class="vt-card__title">{{ timeline.export.fileName }}</span>
      <span class="vt-card__time">{{ mmss(totalSec) }}/{{ mmss(totalSec) }}</span>
      <button
        type="button"
        class="vt-card__icon"
        data-timeline-edit
        title="编辑时间线（与 agent 共用同一套操作）"
        @pointerdown.stop
        @click.stop="emit('request-edit')"
      >✂</button>
      <button
        v-if="playableTrack"
        type="button"
        class="vt-card__play"
        data-timeline-play
        :title="playTitle()"
        @pointerdown.stop
        @click.stop="requestPlay"
      >▶</button>
      <button
        type="button"
        class="vt-card__export"
        data-timeline-export
        :disabled="!renderEnabled || status === 'queued' || status === 'rendering'"
        :title="exportTitle()"
        @pointerdown.stop
        @click.stop="requestRender"
      >
        导出
      </button>
    </header>

    <div class="vt-card__ruler">
      <span v-for="tick in 6" :key="tick">{{ mmss((totalSec / 5) * (tick - 1)) }}</span>
    </div>

    <div class="vt-card__track">
      <div
        v-for="(track, i) in visualTracks"
        :key="track.nodeId"
        class="vt-card__clip"
        data-timeline-clip
        :style="{ '--vt-pct': widthPct(track) }"
        :title="`${track.title} · ${mmss(clipDurationSec(track))}`"
      >
        <img v-if="track.type === 'image'" :src="track.url" :alt="track.title" class="vt-card__thumb" />
        <span v-else class="vt-card__thumb vt-card__thumb--video" />
        <span class="vt-card__clip-title">{{ track.title }}</span>
        <span class="vt-card__clip-index">{{ i + 1 }}</span>
      </div>
    </div>

    <div v-for="idx in [0, 1]" :key="idx" class="vt-card__audio-track">
      <span class="vt-card__audio-label">A{{ idx + 1 }}</span>
      <div class="vt-card__audio-lane">
        <div
          v-for="track in audioTracks.filter((t) => t.audioTrackIndex === idx)"
          :key="track.nodeId"
          class="vt-card__audio-clip"
          :style="{ left: leftPct(track.startSec), width: widthPct(track) }"
          :title="`${track.title} · ${mmss(track.startSec)}`"
        />
      </div>
    </div>

    <footer class="vt-card__footer">
      {{ timeline.export.resolution }} · {{ timeline.export.format }} · {{ timeline.export.muted ? '静音' : '有声' }}
    </footer>
  </section>
</template>

<style scoped>
.vt-card {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--lnk-border-subtle);
  border-radius: 8px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: 12px;
}
.vt-card__header,
.vt-card__footer,
.vt-card__ruler {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vt-card__title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vt-card__time,
.vt-card__footer {
  color: var(--lnk-text-secondary, var(--lnk-text-primary));
  font-variant-numeric: tabular-nums;
}
.vt-card__icon,
.vt-card__export,
.vt-card__play {
  border: 1px solid var(--lnk-border-subtle);
  border-radius: 4px;
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  cursor: pointer;
}
.vt-card__icon:disabled,
.vt-card__export:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
/* 播放钮常驻 DOM（移动端可见可点）；hover 只做视觉增强，不做存在性切换，避免形态切换误触。 */
.vt-card__play {
  padding: 2px 6px;
  color: var(--lnk-accent-text);
}
.vt-card__play:hover {
  background: var(--lnk-accent-subtle);
}
.vt-card__export {
  padding: 2px 10px;
  color: var(--lnk-accent-text);
}
/* hover 展开入口 affordance：编辑按钮高亮（纯视觉，不改变 DOM 存在性）。 */
.vt-card:hover .vt-card__icon:not(:disabled) {
  border-color: var(--lnk-accent-border);
  color: var(--lnk-accent-text);
}
.vt-card__ruler {
  justify-content: space-between;
  margin-top: 8px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.vt-card__track {
  display: flex;
  height: 54px;
  overflow: hidden;
  border-radius: 4px;
  background: var(--lnk-surface-sunken);
}
.vt-card__clip {
  position: relative;
  flex-shrink: 0;
  width: var(--vt-pct, 0%);
  border-right: 1px solid var(--lnk-border-subtle);
  overflow: hidden;
}
/* 竖屏（9:16 等）：片段块纵向堆叠，同一时长百分比改作高度，杜绝横线挤压。 */
.vt-card--portrait .vt-card__track {
  flex-direction: column;
  height: 120px;
}
.vt-card--portrait .vt-card__clip {
  width: 100%;
  height: var(--vt-pct, 0%);
  flex-shrink: 0;
  border-right: none;
  border-bottom: 1px solid var(--lnk-border-subtle);
}
.vt-card__thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.vt-card__thumb--video {
  background: var(--lnk-accent-subtle);
}
.vt-card__clip-title {
  position: absolute;
  top: 2px;
  left: 2px;
  right: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow: 0 1px 2px var(--lnk-surface-canvas);
}
.vt-card__clip-index {
  position: absolute;
  left: 2px;
  bottom: 2px;
  padding: 0 3px;
  border-radius: 2px;
  background: var(--lnk-surface-overlay);
}
.vt-card__audio-track {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.vt-card__audio-label {
  width: 18px;
  font-size: 10px;
}
.vt-card__audio-lane {
  position: relative;
  flex: 1;
  height: 10px;
  border-radius: 3px;
  background: var(--lnk-surface-sunken);
}
.vt-card__audio-clip {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: 3px;
  background: var(--lnk-accent-border);
}
.vt-card__footer {
  margin-top: 8px;
  justify-content: flex-end;
}
</style>
