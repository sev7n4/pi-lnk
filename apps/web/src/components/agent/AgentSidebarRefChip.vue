<script setup lang="ts">
import { computed, ref } from 'vue'
import type { NodeRef, RefMediaType } from '@/composables/useNodeRefs'
import DockTypeIcon from '@/components/canvas/dock-studio/shared/DockTypeIcon.vue'
import AgentRefHoverPreview from '@/components/agent/AgentRefHoverPreview.vue'
import AgentRefDetailSheet from '@/components/agent/AgentRefDetailSheet.vue'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
import { resolveMediaUrl } from '@/services/api-base'
import type { DockNodeIconKind } from '@/components/canvas/dock-studio/shared/dockIcons'
import { anchorFromElement, type AnchorRect } from '@/utils/refPreviewPosition'

const props = defineProps<{
  refItem: NodeRef
  clickable?: boolean
  draggable?: boolean
  dragging?: boolean
  dragOver?: boolean
  /** composer = 输入区（hover 预览）；history = 历史气泡（hover 预览 + 「再次引用」动作） */
  variant?: 'composer' | 'history'
}>()

const emit = defineEmits<{
  mention: [refKey: string]
  remove: []
  dragstart: [event: DragEvent]
  dragover: [event: DragEvent]
  dragleave: []
  drop: [event: DragEvent]
  dragend: []
}>()

const { isMobileLayout } = useAgentMobileLayout()
const chipEl = ref<HTMLElement | null>(null)
const previewOpen = ref(false)
const previewAnchor = ref<AnchorRect | null>(null)
const hoverTimer = ref<number | null>(null)
const isHoveringPreview = ref(false)
/** PC 点击 / 卡内「展开」后钉住：不随 mouseleave 关闭，可滚动全文 / 播放媒体 */
const pinned = ref(false)
/** 触屏无 hover：点击直接开全宽 sheet，绝不复用 hover 定位逻辑 */
const sheetOpen = ref(false)

const MEDIA_ICON: Record<RefMediaType, DockNodeIconKind> = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
}

const thumbUrl = computed(() => {
  if (props.refItem.mediaType !== 'image' && props.refItem.mediaType !== 'video') return ''
  const raw = props.refItem.payload.url ?? props.refItem.preview
  return raw ? resolveMediaUrl(raw) : ''
})

function clearHoverTimer() {
  if (hoverTimer.value !== null) {
    window.clearTimeout(hoverTimer.value)
    hoverTimer.value = null
  }
}

const isHistory = computed(() => props.variant === 'history')

const chipTitle = computed(() => `${props.refItem.refKey} · ${props.refItem.label}`)
const actionLabel = computed(() =>
  `${isHistory.value ? '再次引用' : '引用'} @${props.refItem.refKey}`,
)

function onEnter(event: MouseEvent) {
  if (isMobileLayout.value || pinned.value) return
  clearHoverTimer()
  const el = event.currentTarget
  if (el instanceof HTMLElement) {
    previewAnchor.value = anchorFromElement(el)
  }
  hoverTimer.value = window.setTimeout(() => {
    previewOpen.value = true
  }, 200)
}

function onLeave() {
  if (isMobileLayout.value || pinned.value) return
  clearHoverTimer()
  hoverTimer.value = window.setTimeout(() => {
    if (!isHoveringPreview.value) previewOpen.value = false
  }, 80)
}

function onPreviewEnter() {
  clearHoverTimer()
  isHoveringPreview.value = true
}

function onPreviewLeave() {
  isHoveringPreview.value = false
  if (pinned.value) return
  previewOpen.value = false
}

/** 卡内点「展开全文 / 查看大图 / 播放」⇒ 钉住，避免 80ms 自动关把交互吃掉。 */
function onPreviewPin() {
  clearHoverTimer()
  pinned.value = true
  previewOpen.value = true
}

function closePreview() {
  clearHoverTimer()
  pinned.value = false
  previewOpen.value = false
}

function onAction() {
  emit('mention', props.refItem.refKey)
  closePreview()
  sheetOpen.value = false
}

function onRemoveClick(event: MouseEvent) {
  event.stopPropagation()
  emit('remove')
}

/**
 * 点击芯片 = **查看内容**（此前只插 @T1，用户 hover/点击都看不到文档正文）。
 * PC → 钉住 hover 卡；移动端 → MobileSheet。@T1 / 再次引用移到详情面的拇指区动作。
 */
function onClick() {
  if (!props.clickable || props.refItem.stale) return
  if (isMobileLayout.value) {
    sheetOpen.value = true
    return
  }
  previewAnchor.value = (chipEl.value ? anchorFromElement(chipEl.value) : null) ?? previewAnchor.value
  clearHoverTimer()
  previewOpen.value = true
  pinned.value = true
}
</script>

<template>
  <div
    ref="chipEl"
    class="dock-ref-chip"
    :class="{
      'dock-ref-chip--history': isHistory,
      'is-stale': refItem.stale,
      'has-media': !!thumbUrl,
      'is-readonly': !clickable,
      'is-dragging': dragging,
      'is-drag-over': dragOver,
    }"
    :draggable="draggable"
    :title="chipTitle"
    role="button"
    tabindex="0"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @click="onClick"
    @keydown.enter.prevent="onClick"
    @dragstart="emit('dragstart', $event)"
    @dragover="emit('dragover', $event)"
    @dragleave="emit('dragleave')"
    @drop="emit('drop', $event)"
    @dragend="emit('dragend')"
  >
    <span v-if="isHistory" class="dock-ref-chip__reattach-badge" aria-hidden="true">↺</span>
    <span v-if="isHistory" class="dock-ref-chip__reattach-tip">查看内容</span>
    <span class="dock-ref-chip__key">{{ refItem.refKey }}</span>

    <img
      v-if="thumbUrl && refItem.mediaType === 'image'"
      :src="thumbUrl"
      alt=""
      class="dock-ref-chip__media"
      draggable="false"
    >
    <video
      v-else-if="thumbUrl && refItem.mediaType === 'video'"
      :src="thumbUrl"
      class="dock-ref-chip__media"
      muted
      playsinline
      preload="metadata"
      draggable="false"
    />
    <span v-else class="dock-ref-chip__icon" aria-hidden="true">
      <DockTypeIcon :icon="MEDIA_ICON[refItem.mediaType]" :size="14" />
    </span>

    <button
      v-if="!isHistory"
      type="button"
      class="dock-ref-chip__remove"
      aria-label="移除引用"
      @click="onRemoveClick"
    >
      <svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  </div>

  <AgentRefHoverPreview
    v-if="previewOpen && previewAnchor"
    :ref-item="refItem"
    :anchor="previewAnchor"
    :pinned="pinned"
    :action-label="actionLabel"
    @mouseenter="onPreviewEnter"
    @mouseleave="onPreviewLeave"
    @pin="onPreviewPin"
    @close="closePreview"
    @action="onAction"
  />

  <AgentRefDetailSheet
    v-if="sheetOpen"
    :ref-item="refItem"
    :action-label="actionLabel"
    @close="sheetOpen = false"
    @action="onAction"
  />
</template>

<style scoped>
.dock-ref-chip {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  overflow: hidden;
  border: 1px solid var(--neo-border-strong);
  border-radius: 8px;
  background: var(--neo-hover-bg);
  color: var(--neo-text-secondary);
  cursor: pointer;
  user-select: none;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    opacity 0.15s ease,
    transform 0.12s ease;
}

.dock-ref-chip--history {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--neo-text-primary) 22%, var(--neo-border));
}

.dock-ref-chip--history:not(.is-stale):hover {
  border-color: color-mix(in srgb, var(--neo-hi-text) 32%, var(--neo-border));
  transform: scale(1.05);
}

.dock-ref-chip__reattach-badge {
  position: absolute;
  right: 1px;
  bottom: 1px;
  z-index: 2;
  display: flex;
  width: 12px;
  height: 12px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: color-mix(in srgb, var(--neo-bg) 72%, transparent);
  font-size: 8px;
  line-height: 1;
  color: var(--neo-text-primary);
  pointer-events: none;
}

.dock-ref-chip__reattach-tip {
  position: absolute;
  bottom: calc(100% + 5px);
  left: 50%;
  z-index: 3;
  padding: 3px 7px;
  border: 1px solid var(--neo-border);
  border-radius: 6px;
  background: var(--neo-popover-bg);
  font-size: 9px;
  line-height: 1.2;
  white-space: nowrap;
  color: var(--neo-text-secondary);
  pointer-events: none;
  opacity: 0;
  transform: translateX(-50%) translateY(2px);
  transition: opacity 0.15s ease, transform 0.15s ease;
  box-shadow: var(--neo-popover-shadow);
}

.dock-ref-chip--history:hover .dock-ref-chip__reattach-tip {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.dock-ref-chip.is-readonly {
  cursor: default;
}

.dock-ref-chip.is-dragging {
  opacity: 0.45;
}

.dock-ref-chip.is-drag-over {
  border-color: color-mix(in srgb, var(--neo-hi-text) 35%, var(--neo-border));
  background: var(--neo-hover-bg);
}

.dock-ref-chip:active[draggable='true'] {
  cursor: grabbing;
}

.dock-ref-chip.is-stale {
  border-style: dashed;
  border-color: var(--neo-border);
  background: var(--neo-hover-bg);
  color: var(--neo-text-muted);
  cursor: default;
}

.dock-ref-chip__key {
  position: absolute;
  top: 1px;
  left: 2px;
  z-index: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.02em;
  color: var(--neo-text-primary);
  pointer-events: none;
}

.dock-ref-chip.has-media .dock-ref-chip__key {
  color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

.dock-ref-chip__media {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.dock-ref-chip.is-stale .dock-ref-chip__media {
  opacity: 0.4;
  filter: grayscale(1);
}

.dock-ref-chip__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.75;
}

.dock-ref-chip__remove {
  position: absolute;
  top: 1px;
  right: 1px;
  z-index: 2;
  display: none;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.65);
  color: rgba(255, 255, 255, 0.85);
}

.dock-ref-chip:hover .dock-ref-chip__remove {
  display: inline-flex;
}

.dock-ref-chip__remove:hover {
  background: var(--lnk-error);
}
</style>
