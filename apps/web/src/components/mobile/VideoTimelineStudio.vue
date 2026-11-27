<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { clipDurationSec, visualDurationSec, type TimelineOp, type VideoTimeline } from '@lnkpi/shared'
import { createEditSession, type VideoTimelineEditSession } from '@/composables/useVideoTimelineEditSession'
import type { TimelineSource } from '@/composables/useVideoTimelineEdit'
import { useTimelineAxis } from '@/components/timeline/useTimelineAxis'
import TimelineRuler from '@/components/timeline/TimelineRuler.vue'
import TimelinePlayhead from '@/components/timeline/TimelinePlayhead.vue'
import TimelineClip from '@/components/timeline/TimelineClip.vue'
import TimelineAudioLane from '@/components/timeline/TimelineAudioLane.vue'

/**
 * P2.6 移动端视频时间线全屏编辑器（对标剪映移动截图）。
 *
 * ⭐ Teleport 到 body + fixed inset 0：与 MobileNodeTile 壳层手势彻底隔离；
 *   DOM 下沉（v-if）+ capture 意图守卫（500ms）+ 关闭形态复位，防误触三件套齐备。
 * ⭐ 时间轴复用 P2.2 共享原子组件（同一坐标系），编辑会话复用 createEditSession，
 *   提交走父级 submitTimelineOps（双通道同一写治理），不另造 reducer/播放器。
 */
const props = defineProps<{
  nodeId: string
  timeline: VideoTimeline
  sources?: TimelineSource[]
  /** 节点请求比例（16:9 / 9:16 / 3:4 / 21:9 …），用于预览区形状。 */
  aspectRatio?: string
  renderEnabled?: boolean
  saveError?: string
}>()

const emit = defineEmits<{
  close: []
  commit: [ops: TimelineOp[]]
  preview: [payload: { url: string; title: string; estimated: boolean }]
  'request-render': []
}>()

const session: VideoTimelineEditSession = createEditSession(props.timeline, props.sources)
watch(() => props.sources, (next) => session.setSources(next), { deep: true })
const previewTimeline = computed(() => session.preview.value.timeline ?? props.timeline)
const playheadSec = ref(0)
const selectedNodeId = ref<string | null>(null)
/** 底部两级工具栏：一级 tab（剪辑/音频）→ 组内按钮；DOM 下沉避免形态切换误触。 */
type ToolTab = 'clip' | 'audio'
const activeTab = ref<ToolTab>('clip')

const visualTracks = computed(() => {
  const t = previewTimeline.value
  const order = new Map(t.trackOrder.map((id, i) => [id, i]))
  return t.tracks
    .filter((x) => x.type === 'video' || x.type === 'image')
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
})
const audioTracks = computed(() => previewTimeline.value.tracks.filter((x) => x.type === 'audio'))
const totalSec = computed(() => visualDurationSec(previewTimeline.value))
const axis = useTimelineAxis({ totalSec: () => totalSec.value, viewportWidth: () => 360 })

const visualStarts = computed(() => {
  const starts = new Map<string, number>()
  let acc = 0
  for (const t of visualTracks.value) {
    starts.set(t.nodeId, acc)
    acc += clipDurationSec(t)
  }
  return starts
})
const snapEdges = computed(() => {
  const edges = [0, totalSec.value]
  for (const t of visualTracks.value) {
    const start = visualStarts.value.get(t.nodeId) ?? 0
    edges.push(start, start + clipDurationSec(t))
  }
  for (const a of audioTracks.value) edges.push(a.startSec, a.startSec + a.durationSec)
  return edges
})

function mmss(sec: number) {
  const v = Math.max(0, Math.round(sec))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}
function apply(op: TimelineOp) { session.applyOp(op) }

function selectClip(nodeId: string) {
  selectedNodeId.value = nodeId
  const track = previewTimeline.value.tracks.find((x) => x.nodeId === nodeId)
  playheadSec.value = track?.type === 'audio'
    ? track.startSec
    : (visualStarts.value.get(nodeId) ?? 0)
}

function splitSelected() {
  const id = selectedNodeId.value
  if (!id) return
  const track = previewTimeline.value.tracks.find((x) => x.nodeId === id)
  if (!track) return
  const inSec = track.sourceInSec ?? 0
  const globalStart = track.type === 'audio' ? track.startSec : (visualStarts.value.get(id) ?? 0)
  apply({ op: 'split', node_id: id, at_sec: inSec + (playheadSec.value - globalStart) })
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
function duplicateSelected() {
  const id = selectedNodeId.value
  if (!id) return
  apply({ op: 'duplicate', node_id: id })
}
/** 与 PC 浮层同一套 trim 语义（共享 TimelineClip 手柄 payload），不另造裁剪口径。 */
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
function trimSelectedHead() {
  if (!selectedNodeId.value) return
  onTrim({ nodeId: selectedNodeId.value, edge: 'in', deltaSec: 0.5 })
}
const selectedTrack = computed(() => previewTimeline.value.tracks.find((x) => x.nodeId === selectedNodeId.value))
const selectedIsAudio = computed(() => selectedTrack.value?.type === 'audio')

function audioSourceCandidates() {
  const inTimeline = new Set(previewTimeline.value.tracks.map((t) => t.nodeId))
  return (props.sources ?? []).filter((s) => s.type === 'audio' && s.url && !inTimeline.has(s.nodeId))
}
function addAudio() {
  const source = audioSourceCandidates()[0]
  if (!source) return
  apply({ op: 'add_audio', node_id: source.nodeId, audio_track_index: 0, start_sec: 0 })
  selectClip(source.nodeId)
}
function setVolume(delta: number) {
  const id = selectedNodeId.value
  const track = selectedTrack.value
  if (!id || track?.type !== 'audio') return
  apply({ op: 'set_volume', node_id: id, volume: Math.min(2, Math.max(0, (track.volume ?? 1) + delta)) })
}
function toggleMute() {
  const id = selectedNodeId.value
  const track = selectedTrack.value
  if (!id || track?.type !== 'audio') return
  apply({ op: 'set_volume', node_id: id, volume: track.volume ?? 1, muted: !track.muted })
}

function previewSelected() {
  const track = selectedTrack.value
  if (!track?.url) return
  emit('preview', { url: track.url, title: track.title, estimated: Boolean(track.durationEstimated) })
}
function commit() {
  if (!session.canUndo.value) return
  emit('commit', session.commitOps())
}

/** 预览区比例：requests 比例字符串解析，非法回退 16:9。 */
const previewRatio = computed(() => {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(String(props.aspectRatio ?? '').trim())
  if (!m) return 16 / 9
  const [_, w, h] = m
  const n = Number(w) / Number(h)
  return Number.isFinite(n) && n > 0 ? n : 16 / 9
})
const previewStyle = computed(() => ({ aspectRatio: `${previewRatio.value}` }))

/* ---- 防误触三件套：capture 意图守卫（500ms，同 AutoApproveControl 范式） ----
 * tab 切换后新按钮 DOM 下沉出现；若 pointerdown 落在新按钮之外却在 500ms 内产生 click，
 * 视为 ghost click / 误触而拦截。键盘激活（无 pointerdown）放行。 */
const POINTER_INTENT_WINDOW_MS = 500
let pointerDownAt = 0
let pointerDownInToolbar = false
const toolbarRef = ref<HTMLElement | null>(null)
function onDocPointerDown(e: PointerEvent) {
  pointerDownAt = Date.now()
  const node = e.target as Node | null
  pointerDownInToolbar = !!(node && toolbarRef.value && toolbarRef.value.contains(node))
}
function onToolbarClickCapture(e: MouseEvent) {
  const withinWindow = pointerDownAt > 0 && Date.now() - pointerDownAt < POINTER_INTENT_WINDOW_MS
  if (withinWindow && !pointerDownInToolbar) {
    e.preventDefault()
    e.stopPropagation()
  }
}
function switchTab(tab: ToolTab) {
  activeTab.value = tab
  pointerDownAt = 0 // 形态复位：切换后清空意图窗，新 tab 内按钮立即可用
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) session.redo()
    else session.undo()
  }
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div class="vts" data-vts-studio @pointerdown.stop @touchstart.stop @touchmove.stop>
      <header class="vts__top">
        <button type="button" class="vts__icon" data-vts-close title="关闭（Esc）" @click="emit('close')">✕</button>
        <span class="vts__title">{{ timeline.export.fileName }}</span>
        <span class="vts__ratio">{{ aspectRatio || '16:9' }}</span>
        <span class="vts__quality">{{ timeline.export.resolution }}</span>
        <button
          type="button"
          class="vts__export"
          data-vts-export
          :disabled="!renderEnabled"
          @click="emit('request-render')"
        >导出</button>
      </header>

      <div class="vts__preview" :style="previewStyle" data-vts-preview-area>
        <button type="button" class="vts__preview-play" data-vts-preview-play @click="previewSelected">▶ 预览选中片段</button>
      </div>

      <div class="vts__transport">
        <span class="vts__time" data-vts-time>{{ mmss(playheadSec) }}/{{ mmss(totalSec) }}</span>
        <button type="button" class="vts__icon" data-vts-zoom-out title="缩小时间轴" @click="axis.zoomOut()">−</button>
        <button type="button" class="vts__icon" data-vts-zoom-in title="放大时间轴" @click="axis.zoomIn()">＋</button>
        <button type="button" class="vts__icon" data-vts-undo :disabled="!session.canUndo.value" @click="session.undo()">↶</button>
        <button type="button" class="vts__icon" data-vts-redo :disabled="!session.canRedo.value" @click="session.redo()">↷</button>
      </div>

      <div class="vts__timeline-scroll" data-vts-timeline-scroll>
        <div class="vts__timeline-content" :style="{ width: `${axis.contentWidth.value}px` }">
          <TimelineRuler :axis="axis" @seek="playheadSec = $event" />
          <div class="vts__track" data-vts-visual-track>
            <TimelineClip
              v-for="(track, i) in visualTracks"
              :key="track.nodeId"
              :axis="axis"
              :track="track"
              :start-sec="visualStarts.get(track.nodeId) ?? 0"
              :index="i"
              :selected="selectedNodeId === track.nodeId"
              @select="selectClip"
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
            @select="selectClip"
          />
          <TimelinePlayhead
            :axis="axis"
            :sec="playheadSec"
            :snap-edges="snapEdges"
            :height="150"
            @seek="playheadSec = $event"
          />
        </div>
      </div>

      <div ref="toolbarRef" class="vts__toolbar" data-vts-toolbar @click.capture="onToolbarClickCapture">
        <div class="vts__tabs" data-vts-tabs>
          <button type="button" class="vts__tab" :class="{ 'is-active': activeTab === 'clip' }" data-vts-tab-clip @click="switchTab('clip')">剪辑</button>
          <button type="button" class="vts__tab" :class="{ 'is-active': activeTab === 'audio' }" data-vts-tab-audio @click="switchTab('audio')">音频</button>
        </div>
        <div v-if="activeTab === 'clip'" class="vts__tools" data-vts-tools-clip>
          <button type="button" class="vts__tool" data-vts-split :disabled="!selectedNodeId" @click="splitSelected">分割</button>
          <button type="button" class="vts__tool" data-vts-trim :disabled="!selectedNodeId" @click="trimSelectedHead">裁剪头</button>
          <button type="button" class="vts__tool" data-vts-remove :disabled="!selectedNodeId" @click="removeSelected">删除</button>
          <button type="button" class="vts__tool" data-vts-move-left :disabled="!selectedNodeId" @click="moveSelected(Math.max(0, previewTimeline.trackOrder.indexOf(selectedNodeId!) - 1))">左移</button>
          <button type="button" class="vts__tool" data-vts-move-right :disabled="!selectedNodeId" @click="moveSelected(Math.min(previewTimeline.trackOrder.length - 1, previewTimeline.trackOrder.indexOf(selectedNodeId!) + 1))">右移</button>
          <button type="button" class="vts__tool" data-vts-duplicate :disabled="!selectedNodeId" @click="duplicateSelected">复制</button>
        </div>
        <div v-else class="vts__tools" data-vts-tools-audio>
          <button type="button" class="vts__tool" data-vts-audio-add :disabled="!audioSourceCandidates().length" @click="addAudio">＋音频</button>
          <button type="button" class="vts__tool" data-vts-vol-up :disabled="!selectedIsAudio" @click="setVolume(0.1)">音量＋</button>
          <button type="button" class="vts__tool" data-vts-vol-down :disabled="!selectedIsAudio" @click="setVolume(-0.1)">音量－</button>
          <button type="button" class="vts__tool" data-vts-mute :disabled="!selectedIsAudio" @click="toggleMute">静音</button>
          <button type="button" class="vts__tool" data-vts-audio-split :disabled="!selectedIsAudio" @click="splitSelected">音频分割</button>
          <button type="button" class="vts__tool" data-vts-audio-trim :disabled="!selectedIsAudio" @click="trimSelectedHead">音频裁剪</button>
        </div>
        <div class="vts__done">
          <button type="button" class="vts__done-btn" data-vts-commit :disabled="!session.canUndo.value" @click="commit">完成</button>
        </div>
      </div>
      <p class="vts__help" data-vts-help>支持裁剪 / 分割 / 排序 / 复制 / 混音；转场、特效、贴纸、关键帧不在本工具范围（渲染内核不支持，故不提供按钮）。</p>
      <div v-if="saveError" class="vts__error" data-vts-error role="alert">保存失败：{{ saveError }}（编辑内容已保留，可重试）</div>
    </div>
  </Teleport>
</template>

<style scoped>
.vts {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  font-size: 13px;
  touch-action: manipulation;
}
.vts__top { display: flex; align-items: center; gap: 8px; padding: 8px 12px; min-height: var(--lnk-touch-target); }
.vts__title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.vts__ratio, .vts__quality { color: var(--lnk-text-secondary); font-size: var(--lnk-text-2xs); }
.vts__icon, .vts__export, .vts__tab, .vts__tool, .vts__done-btn {
  min-height: var(--lnk-touch-target);
  padding: 4px 12px;
  border: 1px solid var(--lnk-border-subtle);
  border-radius: 6px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  cursor: pointer;
}
.vts__icon:disabled, .vts__export:disabled, .vts__tool:disabled, .vts__done-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.vts__export, .vts__done-btn { color: var(--lnk-accent-text); border-color: var(--lnk-accent-border); }
.vts__preview {
  width: 100%;
  max-height: 42vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lnk-surface-sunken);
  overflow: hidden;
}
.vts__preview-play { min-height: var(--lnk-touch-target); padding: 6px 16px; border: 1px solid var(--lnk-accent-border); border-radius: 20px; background: var(--lnk-surface-raised); color: var(--lnk-accent-text); cursor: pointer; }
.vts__transport { display: flex; align-items: center; gap: 10px; padding: 6px 12px; }
.vts__time { flex: 1; font-variant-numeric: tabular-nums; color: var(--lnk-text-secondary); }
.vts__timeline-scroll { flex: 1; overflow-x: auto; overflow-y: hidden; padding: 8px 12px; }
.vts__timeline-content { position: relative; }
.vts__track { position: relative; height: 52px; border-radius: 5px; background: var(--lnk-surface-sunken); overflow: hidden; }
.vts__toolbar { padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--lnk-border-subtle); }
.vts__tabs { display: flex; gap: 8px; margin-bottom: 8px; }
.vts__tab.is-active { border-color: var(--lnk-accent-border); color: var(--lnk-accent-text); }
.vts__tools { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.vts__tool { flex: none; }
.vts__done { display: flex; justify-content: flex-end; margin-top: 8px; }
.vts__help { margin: 0; padding: 2px 12px 6px; color: var(--lnk-text-secondary); font-size: var(--lnk-text-2xs); }
.vts__error { padding: 6px 12px; color: var(--lnk-accent-text); }
</style>
