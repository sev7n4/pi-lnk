<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { clipDurationSec, visualDurationSec, type TimelineOp, type VideoTimeline } from '@lnkpi/shared'
import { createEditSession, type VideoTimelineEditSession } from '@/composables/useVideoTimelineEditSession'

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
const previewTimeline = computed(() => session.preview.value.timeline ?? props.timeline)
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
const opSummary = computed(() => session.opCount.value ? `${session.opCount.value} 项待提交操作` : '暂无未提交操作')

function mmss(sec: number) {
  const v = Math.max(0, Math.round(sec))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}
function widthPct(sec: number) {
  return totalSec.value ? `${(sec / totalSec.value) * 100}%` : '0%'
}
function apply(op: TimelineOp) {
  session.applyOp(op)
}

/** 分割：播放头必须落在选中片段当前有效区间内（reducer 再校验一次）。 */
function splitSelected() {
  const id = selectedNodeId.value
  if (!id) return
  apply({ op: 'split', node_id: id, at_sec: playheadSec.value })
}
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
          <input
            class="vtm-playhead"
            data-vt-playhead
            type="range"
            min="0"
            :max="Math.max(1, Math.ceil(totalSec))"
            step="0.5"
            :value="playheadSec"
            @input="playheadSec = Number(($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="vtm-timeline">
          <div class="vtm-ruler">
            <span v-for="tick in 6" :key="tick">{{ mmss((totalSec / 5) * (tick - 1)) }}</span>
          </div>
          <div class="vtm-track" data-vt-visual-track>
            <button
              v-for="(track, i) in visualTracks"
              :key="track.nodeId"
              type="button"
              class="vtm-clip"
              :class="{ 'is-selected': selectedNodeId === track.nodeId }"
              data-vt-clip
              :style="{ width: widthPct(clipDurationSec(track)) }"
              :title="`${track.title} · ${mmss(clipDurationSec(track))}`"
              @click="selectedNodeId = track.nodeId; playheadSec = (track.sourceInSec ?? 0)"
            >
              <span class="vtm-clip-title">{{ i + 1 }}. {{ track.title }}</span>
            </button>
          </div>
          <div v-for="idx in [0, 1]" :key="idx" class="vtm-audio-row">
            <span class="vtm-audio-label">A{{ idx + 1 }}</span>
            <div class="vtm-audio-lane">
              <span
                v-for="track in audioTracks.filter((x) => x.audioTrackIndex === idx)"
                :key="track.nodeId"
                class="vtm-audio-clip"
                :title="`${track.title} · ${mmss(track.startSec)}`"
                :style="{ left: widthPct(track.startSec), width: widthPct(track.durationSec) }"
              />
            </div>
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
.vtm-footer,
.vtm-ruler,
.vtm-audio-row {
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
.vtm-ruler { justify-content: space-between; margin: 10px 0 4px; font-size: 10px; font-variant-numeric: tabular-nums; color: var(--lnk-text-secondary); }
.vtm-track { display: flex; height: 52px; overflow: hidden; border-radius: 5px; background: var(--lnk-surface-sunken); }
.vtm-clip {
  position: relative;
  flex-shrink: 0;
  border: none;
  border-right: 1px solid var(--lnk-border-subtle);
  background: var(--lnk-accent-subtle);
  color: var(--lnk-text-primary);
  cursor: pointer;
  overflow: hidden;
}
.vtm-clip.is-selected { outline: 2px solid var(--lnk-accent-text); outline-offset: -2px; }
.vtm-clip-title { position: absolute; inset: 4px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vtm-audio-row { margin-top: 6px; }
.vtm-audio-label { width: 20px; font-size: 10px; color: var(--lnk-text-secondary); }
.vtm-audio-lane { position: relative; flex: 1; height: 10px; border-radius: 3px; background: var(--lnk-surface-sunken); }
.vtm-audio-clip { position: absolute; top: 0; height: 100%; border-radius: 3px; background: var(--lnk-accent-border); }
.vtm-actions { margin-top: 12px; flex-wrap: wrap; }
.vtm-summary { margin-top: 10px; color: var(--lnk-text-secondary); font-variant-numeric: tabular-nums; }
.vtm-error { margin-top: 6px; color: var(--lnk-accent-text); }
.vtm-footer { margin-top: 12px; justify-content: flex-end; }
</style>
