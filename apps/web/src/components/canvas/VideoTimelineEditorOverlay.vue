<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { clipDurationSec, visualDurationSec, type TimelineOp, type VideoTimeline } from '@lnkpi/shared'
import { createEditSession, type VideoTimelineEditSession } from '@/composables/useVideoTimelineEditSession'
import { useTimelineAxis } from '@/components/timeline/useTimelineAxis'
import TimelineRuler from '@/components/timeline/TimelineRuler.vue'
import TimelinePlayhead from '@/components/timeline/TimelinePlayhead.vue'
import TimelineClip from '@/components/timeline/TimelineClip.vue'
import TimelineAudioLane from '@/components/timeline/TimelineAudioLane.vue'

const props = defineProps<{
  nodeId: string
  timeline: VideoTimeline
  /** 素材源（服务端从 canvas.nodes 注入），供 add_* op 校验真实节点。 */
  sources?: Array<{ nodeId: string; type: string; title?: string; url?: string }>
  /** 节点在屏幕上的锚点（可选）；无则居中模态。 */
  anchor?: { x: number; y: number; width: number; height: number }
  /** 提交失败提示（失败时浮层保留编辑态，不静默丢弃）。 */
  saveError?: string
}>()

const emit = defineEmits<{
  close: []
  /** 完成：提交一批 ops（一次写回），由父走 submitTimelineOps。 */
  commit: [ops: TimelineOp[]]
  /** 播放某片段真实 url。 */
  preview: [payload: { url: string; title: string; estimated: boolean }]
}>()

const session: VideoTimelineEditSession = createEditSession(props.timeline, props.sources)
// P2.5：sources 异步到达后回填 session（openEditor 先拉画布再打开，此处兜底 prop 变化）。
watch(() => props.sources, (next) => session.setSources(next), { deep: true })
const previewTimeline = computed(() => session.preview.value.timeline ?? props.timeline)
/** 播放头：全局视觉轴坐标（0..visualDurationSec），与 ruler/竖线/range 共享。 */
const playheadSec = ref(0)
const selectedNodeId = ref<string | null>(null)

const visualTracks = computed(() => {
  const t = previewTimeline.value
  const order = new Map(t.trackOrder.map((id, i) => [id, i]))
  return t.tracks
    .filter((x) => x.type === 'video' || x.type === 'image')
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
})
const audioTracks = computed(() => previewTimeline.value.tracks.filter((x) => x.type === 'audio'))
const totalSec = computed(() => visualDurationSec(previewTimeline.value))

/** 共享坐标系：总时长变化时同步给 axis（纯 UI 态，不写 op）。 */
const axis = useTimelineAxis({ totalSec: () => totalSec.value, viewportWidth: () => 720 })

/** 每个视觉片段在全局轴上的起点（累计前面片段时长）。 */
const visualStarts = computed(() => {
  const starts = new Map<string, number>()
  let acc = 0
  for (const t of visualTracks.value) {
    starts.set(t.nodeId, acc)
    acc += clipDurationSec(t)
  }
  return starts
})

/** 吸附候选：片段边界 + 两端（剪映「吸附到剪辑点」范式）。 */
const snapEdges = computed(() => {
  const edges = [0, totalSec.value]
  for (const t of visualTracks.value) {
    const start = visualStarts.value.get(t.nodeId) ?? 0
    edges.push(start, start + clipDurationSec(t))
  }
  return edges
})

const opSummary = computed(() => session.opCount.value ? `${session.opCount.value} 项待提交操作` : '暂无未提交操作')

function mmss(sec: number) {
  const v = Math.max(0, Math.round(sec))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}
function apply(op: TimelineOp) {
  session.applyOp(op)
}

/**
 * 分割：竖线是全局视觉轴坐标，reducer.split 用源内坐标。
 * 先定位选中片段的全局起点，再换算：at_sec = sourceInSec + (playhead - 全局起点)。
 */
function splitSelected() {
  const id = selectedNodeId.value
  if (!id) return
  const track = previewTimeline.value.tracks.find((x) => x.nodeId === id)
  if (!track) return
  const inSec = track.sourceInSec ?? 0
  // audio 由 startSec 定位（不在 visualStarts 里）：源内点 = sourceIn + (播放头 - startSec)。
  // visual 由累计视觉时长定位：源内点 = sourceIn + (播放头 - 全局起点)。
  const globalStart = track.type === 'audio' ? track.startSec : (visualStarts.value.get(id) ?? 0)
  apply({ op: 'split', node_id: id, at_sec: inSec + (playheadSec.value - globalStart) })
}

/** P2.5：从画布音频源里挑第一个未入轨的音频加入当前轨。 */
function audioSourceCandidates() {
  const inTimeline = new Set(previewTimeline.value.tracks.map((t) => t.nodeId))
  return (props.sources ?? []).filter((s) => s.type === 'audio' && s.url && !inTimeline.has(s.nodeId))
}
function addAudio() {
  const source = audioSourceCandidates()[0]
  if (!source) return
  const idx: 0 | 1 = 0
  apply({ op: 'add_audio', node_id: source.nodeId, audio_track_index: idx, start_sec: 0 })
  selectedNodeId.value = source.nodeId
}
function setSelectedAudioVolume(delta: number) {
  const id = selectedNodeId.value
  if (!id) return
  const track = previewTimeline.value.tracks.find((x) => x.nodeId === id)
  if (!track || track.type !== 'audio') return
  apply({ op: 'set_volume', node_id: id, volume: Math.min(2, Math.max(0, (track.volume ?? 1) + delta)) })
}
function toggleSelectedAudioMute() {
  const id = selectedNodeId.value
  if (!id) return
  const track = previewTimeline.value.tracks.find((x) => x.nodeId === id)
  if (!track || track.type !== 'audio') return
  apply({ op: 'set_volume', node_id: id, volume: track.volume ?? 1, muted: !track.muted })
}
function shiftSelectedAudioStart(delta: number) {
  const id = selectedNodeId.value
  if (!id) return
  const track = previewTimeline.value.tracks.find((x) => x.nodeId === id)
  if (!track || track.type !== 'audio') return
  const inSec = track.sourceInSec ?? 0
  const outSec = track.sourceOutSec ?? (inSec + track.durationSec)
  apply({ op: 'trim', node_id: id, source_in_sec: inSec, source_out_sec: outSec, duration_sec: Math.max(0.5, track.durationSec + delta) })
}
const selectedTrack = computed(() => previewTimeline.value.tracks.find((x) => x.nodeId === selectedNodeId.value))
const selectedIsAudio = computed(() => selectedTrack.value?.type === 'audio')
function removeSelected() {
  if (!selectedNodeId.value) return
  apply({ op: 'remove', node_id: selectedNodeId.value })
  selectedNodeId.value = null
}
function moveSelected(to: number) {
  const id = selectedNodeId.value
  if (!id) return
  const from = previewTimeline.value.trackOrder.indexOf(id)
  if (from < 0) return
  apply({ op: 'move_visual', from, to })
}
function trimSelectedHead() {
  const id = selectedNodeId.value
  if (!id) return
  const track = previewTimeline.value.tracks.find((x) => x.nodeId === id)
  if (!track) return
  apply({ op: 'trim', node_id: id, source_in_sec: (track.sourceInSec ?? 0) + 0.5, source_out_sec: track.sourceOutSec ?? track.durationSec })
}
function onTrim(payload: { nodeId: string; edge: 'in' | 'out'; deltaSec: number }) {
  const track = previewTimeline.value.tracks.find((x) => x.nodeId === payload.nodeId)
  if (!track) return
  const inSec = track.sourceInSec ?? 0
  const outSec = track.sourceOutSec ?? track.durationSec
  if (payload.edge === 'in') {
    apply({ op: 'trim', node_id: payload.nodeId, source_in_sec: Math.max(0, inSec + payload.deltaSec), source_out_sec: outSec })
  } else {
    apply({ op: 'trim', node_id: payload.nodeId, source_in_sec: inSec, source_out_sec: Math.max(inSec + 0.1, outSec + payload.deltaSec) })
  }
}
function previewSelected() {
  if (!selectedNodeId.value) return
  const track = previewTimeline.value.tracks.find((x) => x.nodeId === selectedNodeId.value)
  if (track?.url) emit('preview', { url: track.url, title: track.title, estimated: Boolean(track.durationEstimated) })
}
function commit() {
  if (!session.canUndo.value) return
  emit('commit', session.commitOps())
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) session.redo()
    else session.undo()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const panelStyle = computed(() => {
  if (!props.anchor) return {}
  return {
    left: `${Math.max(8, props.anchor.x + props.anchor.width / 2 - 320)}px`,
    top: `${Math.max(8, props.anchor.y + props.anchor.height + 8)}px`,
  }
})
</script>

<template>
  <Teleport to="body">
    <div class="vtm-overlay" data-vt-overlay @click.self="emit('close')">
      <section class="vtm-panel" :style="panelStyle" role="dialog" aria-label="编辑时间线">
        <header class="vtm-header">
          <span class="vtm-title">编辑时间线 · {{ timeline.export.fileName }}</span>
          <button type="button" class="vtm-btn" data-vt-close title="关闭（Esc）" @click="emit('close')">✕</button>
        </header>

        <div class="vtm-transport">
          <button type="button" class="vtm-btn" data-vt-preview title="播放选中片段" :disabled="!selectedNodeId" @click="previewSelected">▶ 播放</button>
          <span class="vtm-time" data-vt-time>{{ mmss(playheadSec) }}/{{ mmss(totalSec) }}</span>
          <!-- 精确输入滑杆：与贯穿竖线绑定同一 playheadSec（剪映：滑杆精调 + 竖线拖拽） -->
          <input
            class="vtm-playhead"
            data-vt-playhead
            type="range"
            min="0"
            :max="Math.max(1, totalSec)"
            step="0.1"
            :value="playheadSec"
            @input="playheadSec = Number(($event.target as HTMLInputElement).value)"
          />
          <button type="button" class="vtm-btn" data-vt-zoom-out title="缩小时间轴" @click="axis.zoomOut()">−</button>
          <span class="vtm-zoom">{{ axis.zoom.value.toFixed(1) }}×</span>
          <button type="button" class="vtm-btn" data-vt-zoom-in title="放大时间轴" @click="axis.zoomIn()">＋</button>
        </div>

        <!-- 共享滚动容器：ruler / 视觉轨 / 音轨 / 播放头在同一内容坐标系，横滑不错位 -->
        <div class="vtm-timeline-scroll" data-vt-timeline-scroll>
          <div class="vtm-timeline-content" :style="{ width: `${axis.contentWidth.value}px` }">
            <TimelineRuler :axis="axis" @seek="playheadSec = $event" />

            <div class="vtm-track" data-vt-visual-track>
              <TimelineClip
                v-for="(track, i) in visualTracks"
                :key="track.nodeId"
                :axis="axis"
                :track="track"
                :start-sec="visualStarts.get(track.nodeId) ?? 0"
                :index="i"
                :selected="selectedNodeId === track.nodeId"
                @select="selectedNodeId = $event; playheadSec = visualStarts.get($event) ?? 0"
                @trim="onTrim"
              />
            </div>

            <TimelineAudioLane
              v-for="idx in [0, 1] as const"
              :key="idx"
              :axis="axis"
              :index="idx"
              :tracks="audioTracks"
              :selected-node-id="selectedNodeId"
              @select="selectedNodeId = $event; playheadSec = (previewTimeline.tracks.find((t) => t.nodeId === $event)?.startSec ?? 0)"
            />

            <!-- 贯穿竖线：覆盖 ruler + 视觉轨 + 音轨；拖动/点击定位 + 6px 吸附 -->
            <TimelinePlayhead
              :axis="axis"
              :sec="playheadSec"
              :snap-edges="snapEdges"
              :height="160"
              @seek="playheadSec = $event"
            />
          </div>
        </div>

        <div class="vtm-actions">
          <button type="button" class="vtm-btn" data-vt-split :disabled="!selectedNodeId" @click="splitSelected">分割</button>
          <button type="button" class="vtm-btn" data-vt-trim :disabled="!selectedNodeId" @click="trimSelectedHead">裁剪头</button>
          <button type="button" class="vtm-btn" data-vt-remove :disabled="!selectedNodeId" @click="removeSelected">删除</button>
          <button type="button" class="vtm-btn" data-vt-move-left :disabled="!selectedNodeId" @click="moveSelected(Math.max(0, previewTimeline.trackOrder.indexOf(selectedNodeId!) - 1))">左移</button>
          <button type="button" class="vtm-btn" data-vt-move-right :disabled="!selectedNodeId" @click="moveSelected(Math.min(previewTimeline.trackOrder.length - 1, previewTimeline.trackOrder.indexOf(selectedNodeId!) + 1))">右移</button>
          <button type="button" class="vtm-btn" data-vt-undo :disabled="!session.canUndo.value" @click="session.undo()">撤销</button>
          <button type="button" class="vtm-btn" data-vt-redo :disabled="!session.canRedo.value" @click="session.redo()">重做</button>
          <span class="vtm-actions-sep" aria-hidden="true" />
          <button type="button" class="vtm-btn" data-vt-audio-add :disabled="!audioSourceCandidates().length" title="从画布添加音频" @click="addAudio">＋音频</button>
          <button type="button" class="vtm-btn" data-vt-audio-vol-up :disabled="!selectedIsAudio" title="音量 +0.1" @click="setSelectedAudioVolume(0.1)">音量＋</button>
          <button type="button" class="vtm-btn" data-vt-audio-vol-down :disabled="!selectedIsAudio" title="音量 -0.1" @click="setSelectedAudioVolume(-0.1)">音量－</button>
          <button type="button" class="vtm-btn" data-vt-audio-mute :disabled="!selectedIsAudio" title="静音/取消静音" @click="toggleSelectedAudioMute">静音</button>
          <button type="button" class="vtm-btn" data-vt-audio-trim :disabled="!selectedIsAudio" title="音频裁剪头 0.5s" @click="shiftSelectedAudioStart(0.5)">音频裁剪</button>
        </div>

        <div class="vtm-summary" data-vt-summary>{{ opSummary }}</div>
        <div v-if="saveError" class="vtm-error" data-vt-error role="alert">保存失败：{{ saveError }}（编辑内容已保留，可重试）</div>
        <footer class="vtm-footer">
          <button type="button" class="vtm-btn vtm-btn--primary" data-vt-commit :disabled="!session.canUndo.value" @click="commit">完成</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.vtm-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lnk-surface-overlay);
}
.vtm-panel {
  width: min(720px, 92vw);
  max-height: 88vh;
  overflow: auto;
  padding: 16px;
  border: 1px solid var(--lnk-border-subtle);
  border-radius: 10px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: 13px;
}
.vtm-header,
.vtm-transport,
.vtm-actions,
.vtm-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vtm-header { justify-content: space-between; }
.vtm-title { font-weight: 600; }
.vtm-btn {
  padding: 5px 10px;
  border: 1px solid var(--lnk-border-subtle);
  border-radius: 5px;
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  cursor: pointer;
}
.vtm-btn:disabled { cursor: not-allowed; opacity: 0.5; }
.vtm-btn--primary { color: var(--lnk-accent-text); border-color: var(--lnk-accent-border); }
.vtm-time { font-variant-numeric: tabular-nums; color: var(--lnk-text-secondary); }
.vtm-playhead { flex: 1; accent-color: var(--lnk-accent-text); }
.vtm-zoom { font-variant-numeric: tabular-nums; color: var(--lnk-text-secondary); min-width: 32px; text-align: center; }
.vtm-timeline-scroll { overflow-x: auto; overflow-y: hidden; margin: 10px 0; }
.vtm-timeline-content { position: relative; }
.vtm-track { position: relative; height: 52px; overflow: hidden; border-radius: 5px; background: var(--lnk-surface-sunken); }
.vtm-actions { margin-top: 12px; flex-wrap: wrap; }
.vtm-actions-sep { width: 1px; height: 18px; background: var(--lnk-border-subtle); margin: 0 2px; }
.vtm-summary { margin-top: 10px; color: var(--lnk-text-secondary); font-variant-numeric: tabular-nums; }
.vtm-error { margin-top: 6px; color: var(--lnk-accent-text); }
.vtm-footer { margin-top: 12px; justify-content: flex-end; }
</style>
