<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { clipDurationSec, visualDurationSec, type TimelineOp, type VideoTimeline } from '@lnkpi/shared'
import { useLongPress } from '@/composables/useLongPress'
import { useCanvasEditorStore } from '@/stores/canvasEditor'
import { submitTimelineOps } from '@/composables/useVideoTimelineEdit'
import { resolveMediaUrl } from '@/services/api-base'
import VideoTimelineEditorOverlay from '@/components/canvas/VideoTimelineEditorOverlay.vue'

/**
 * P1.5 移动端列表式时间线 tile。
 *
 * ⭐ 自包含：NodeTileView 是纯渲染共享瓦片（零 store/router 依赖），本组件作为
 *   `components/mobile/` 下的呈现，自行持有交互逻辑——播放走 canvasEditor store
 *   的 `openMediaPreview`（复用 P1.3 沉浸式预览壳，不造播放器）；编辑复用 PC 的
 *   `VideoTimelineEditorOverlay`（Teleport 到 body，不撑破 320px 外框）；op 提交
 *   走 `submitTimelineOps`（双通道同一写治理，服务端回读为准）。
 *
 * ⚠️ 手势隔离：本 tile 内嵌在 `MobileNodeTile` 壳的 touch/click 监听域内。根 section
 *   的 touch/click `.stop` 阻止冒泡到壳层，避免「tile 长按排序」与「壳长按出 action
 *   sheet」、「tile 点片段播放」与「壳点瓦片开 viewer」双触发（AGENTS.md 防误触：
 *   DOM 下沉 + 冒泡隔离 + 形态复位）。
 */
const props = defineProps<{
  nodeId: string
  timeline: VideoTimeline
  portrait?: boolean
}>()

const emit = defineEmits<{
  preview: [payload: { url: string; title: string; estimated: boolean }]
  op: [op: TimelineOp]
  'request-edit': []
}>()

const route = useRoute()
const editor = useCanvasEditorStore()
const sessionId = computed(() => route.params.sessionId as string | undefined)

const sortMode = ref(false)
const visualTracks = computed(() => {
  const order = new Map(props.timeline.trackOrder.map((id, i) => [id, i]))
  return props.timeline.tracks
    .filter((t) => t.type === 'video' || t.type === 'image')
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
})
const audioTracks = computed(() => props.timeline.tracks.filter((t) => t.type === 'audio'))
const totalSec = computed(() => visualDurationSec(props.timeline))

function mmss(sec: number) {
  const v = Math.max(0, Math.round(sec))
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`
}

// 复用全局长按实现（400ms + 位移<10px + 抑制合成 click），仅移动端生效。
const longPress = useLongPress(() => { sortMode.value = true })

type PlayPayload = { url: string; title: string; estimated: boolean }

/** 播放：复用 P1.3 的 openMediaPreview（与 PC 收起态播放钮同一壳），不新建播放器。 */
function requestPlay(payload: PlayPayload) {
  if (!payload.url) return
  editor.openMediaPreview({
    url: resolveMediaUrl(payload.url),
    kind: 'video',
    label: payload.title,
    nodeId: props.nodeId,
  })
  emit('preview', payload)
}

function onItemClick(track: { type: string; url: string; title: string; durationEstimated?: boolean }) {
  if (sortMode.value) return // 排序模式下点选不触发播放，防误触
  if (track.type !== 'video' || !track.url) return
  requestPlay({ url: track.url, title: track.title, estimated: Boolean(track.durationEstimated) })
}

/** op 立即提交：与 agent 工具走同一 submitTimelineOps → service.edit → 事务写治理。 */
async function applyTileOp(op: TimelineOp) {
  emit('op', op)
  if (!sessionId.value) return
  await submitTimelineOps({ sessionId: sessionId.value, nodeId: props.nodeId, ops: [op] })
}

function move(index: number, to: number) {
  if (to < 0 || to >= visualTracks.value.length) return
  void applyTileOp({ op: 'move_visual', from: index, to })
}
function remove(index: number) {
  const track = visualTracks.value[index]
  if (!track) return
  void applyTileOp({ op: 'remove', node_id: track.nodeId })
}

// 编辑浮层：复用 PC 的 VideoTimelineEditorOverlay（分割/裁剪/删除/undo/redo/commit）。
const editorOpen = ref(false)
const saveError = ref('')
function openEditor() {
  saveError.value = ''
  sortMode.value = false // 形态复位：进编辑态先退出排序模式
  editorOpen.value = true
  emit('request-edit')
}
async function commitOps(ops: TimelineOp[]) {
  if (!sessionId.value) return
  const res = await submitTimelineOps({ sessionId: sessionId.value, nodeId: props.nodeId, ops })
  if (!res.ok) {
    saveError.value = res.error ?? '保存失败'
    return // 保留浮层编辑态，不静默丢弃
  }
  saveError.value = ''
  editorOpen.value = false // 服务端回读为准；画布经 WS 刷新节点
}
</script>

<template>
  <section
    class="mvt"
    :class="{ 'mvt--portrait': portrait }"
    data-mvt
    @click.stop
    @touchstart.stop
    @touchmove.stop
    @touchend.stop
    @touchcancel.stop
  >
    <header class="mvt__header">
      <span class="mvt__title">{{ timeline.export.fileName }}</span>
      <span class="mvt__time" data-mvt-time>{{ mmss(totalSec) }}</span>
      <button type="button" class="mvt__action" data-mvt-edit title="编辑时间线" @click="openEditor">编辑</button>
      <button type="button" class="mvt__action" data-mvt-sort-mode title="排序" @click="sortMode = !sortMode">排序</button>
    </header>

    <ul class="mvt__list" data-mvt-list>
      <li
        v-for="(track, i) in visualTracks"
        :key="track.nodeId"
        class="mvt__item"
        data-mvt-item
        :style="{ minHeight: 'var(--lnk-touch-target)' }"
        v-bind="longPress"
        @click="onItemClick(track)"
      >
        <span class="mvt__idx">{{ i + 1 }}</span>
        <span class="mvt__thumb" :class="{ 'mvt__thumb--video': track.type === 'video' }" />
        <span class="mvt__label">{{ track.title }}</span>
        <span class="mvt__dur">{{ mmss(clipDurationSec(track)) }}</span>
        <template v-if="sortMode">
          <button type="button" class="mvt__mini" data-mvt-move-up :title="'上移'" @click.stop="move(i, i - 1)">↑</button>
          <button type="button" class="mvt__mini" data-mvt-move-down :title="'下移'" @click.stop="move(i, i + 1)">↓</button>
          <button type="button" class="mvt__mini" data-mvt-remove :title="'删除'" @click.stop="remove(i)">✕</button>
        </template>
      </li>
    </ul>

    <div v-for="idx in [0, 1]" :key="idx" class="mvt__audio-row" data-mvt-audio-row>
      <span class="mvt__audio-label">A{{ idx + 1 }}</span>
      <span class="mvt__audio-names">
        {{ audioTracks.filter((t) => t.audioTrackIndex === idx).map((t) => t.title).join('、') || '—' }}
      </span>
    </div>

    <VideoTimelineEditorOverlay
      v-if="editorOpen"
      :node-id="nodeId"
      :timeline="timeline"
      :save-error="saveError"
      @close="editorOpen = false"
      @commit="commitOps"
      @preview="requestPlay"
    />
  </section>
</template>

<style scoped>
.mvt {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--lnk-border-subtle);
  border-radius: 8px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: 12px;
}
.mvt__header,
.mvt__audio-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mvt__title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mvt__time,
.mvt__audio-row { color: var(--lnk-text-secondary); font-variant-numeric: tabular-nums; }
.mvt__action,
.mvt__mini {
  padding: 4px 8px;
  border: 1px solid var(--lnk-border-subtle);
  border-radius: 4px;
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  cursor: pointer;
}
.mvt__list { list-style: none; margin: 8px 0 0; padding: 0; }
.mvt__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  border-bottom: 1px solid var(--lnk-border-subtle);
  cursor: pointer;
}
.mvt__idx { width: 16px; color: var(--lnk-text-secondary); font-variant-numeric: tabular-nums; }
.mvt__thumb { width: 28px; height: 20px; flex-shrink: 0; border-radius: 3px; background: var(--lnk-surface-sunken); }
.mvt__thumb--video { background: var(--lnk-accent-subtle); }
.mvt__label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mvt__dur { font-variant-numeric: tabular-nums; color: var(--lnk-text-secondary); }
.mvt__mini { padding: 4px 6px; }
.mvt__audio-row { margin-top: 6px; }
.mvt__audio-label { width: 18px; font-size: 10px; }
.mvt__audio-names { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
