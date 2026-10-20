<script setup lang="ts">
/**
 * 画布分组框（2026-10-20 侧车化）。
 *
 * ⚠️ 分组**不是节点**：本组件渲染在 `CanvasData.groups` 侧车数据上，位于 VueFlow
 * 之下层（z-index 0），只有标题条可交互（框体 `pointer-events: none`，与旧
 * `CanvasNodeGroup` 一致）—— 否则整块框会吃掉子节点的点击。
 *
 * 坐标系：容器复用 VueFlow 的 viewport 变换（translate + scale），
 * 框体用画布绝对坐标定位，与 `CanvasGroup.position` 直接对应。
 */
import { computed, nextTick, ref } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import type { CanvasGroup } from '@lnkpi/shared'
import { normalizeGroupColorKey } from './groupColors'
import { clampGroupChipToViewport, groupRectForChildren, type FlowNode } from '../../composables/useCanvasGrouping'

const props = defineProps<{
  groups: CanvasGroup[]
  selectedGroupId?: string | null
  /**
   * 是否允许拖标题条移动整组（2026-10-20）。
   * 移动端传 false：pointer 拖动会与长按手势/多选手势打架，
   * 移动端的多选动作条也还没有分组入口（PR3 才补动作）。
   */
  draggable?: boolean
  /**
   * 画布节点（实时坐标）。外框永远按【当前子节点实时包围盒】渲染，
   * 这样即使 groups 内存的 position/size 是旧落库坐标（节点后来被拖动过），
   * 框也不会错位——彻底消除「框选矩形位置不对 / 没包住节点」的观感。
   */
  nodes?: FlowNode[]
}>()

const emit = defineEmits<{
  select: [groupId: string]
  move: [groupId: string, delta: { x: number; y: number }]
  /** 拖动结束（此时才落库：拖动过程中每帧都写会打爆保存接口）。 */
  'move-end': [groupId: string]
  rename: [groupId: string, title: string]
  /** 标题条上的 × 解组（移除分组框，子节点保持坐标）。 */
  ungroup: [groupId: string]
}>()

// viewport 由 VueFlow 自身提供（组件是 <VueFlow> 的子节点，共享同一 store）。
const { viewport, dimensions } = useVueFlow()

const viewportStyle = computed(() => ({
  transform: `translate(${viewport.value.x}px, ${viewport.value.y}px) scale(${viewport.value.zoom})`,
}))

/** 实时外框：优先按当前子节点包围盒算；子节点缺失时退回落库坐标。 */
function displayRect(group: CanvasGroup) {
  const rect = props.nodes ? groupRectForChildren(props.nodes as FlowNode[], group.childIds) : null
  return rect ?? { position: group.position, size: group.size }
}

/**
 * chip 视口钳制（2026-10-20）：分组可比视口大，框边与默认 chip 位都会在
 * 视口外/被应用骨架裁掉 ⇒ 把 chip 钳到「框 ∩ 视口」可见区，永远留一个
 * 可点（选中/解组/重命名）的锚点。框完全不可见或 pane 尺寸未知 ⇒ 不覆写。
 */
const chipOffsets = computed(() => {
  const map = new Map<string, { top: number; left: number }>()
  // 防御：pane 尺寸未知（部分测试 mock 只给 viewport）⇒ 钳制函数返回 null，退回 CSS 默认位
  const pane = dimensions?.value ?? { width: 0, height: 0 }
  for (const group of props.groups) {
    const offset = clampGroupChipToViewport(displayRect(group), viewport.value, pane)
    if (offset) map.set(group.id, offset)
  }
  return map
})

function chipStyle(groupId: string) {
  const offset = chipOffsets.value.get(groupId)
  return offset ? { top: `${offset.top}px`, left: `${offset.left}px` } : undefined
}

function boxStyle(group: CanvasGroup) {
  const rect = displayRect(group)
  return {
    transform: `translate(${rect.position.x}px, ${rect.position.y}px)`,
    width: `${rect.size.width}px`,
    height: `${rect.size.height}px`,
    // 色值本体在 `--neo-group-*` 令牌（两主题成对定义），组件内无字面 hex。
    '--neo-group-accent': `var(--neo-group-${normalizeGroupColorKey(group.colorKey)})`,
  }
}

// ── 拖拽（标题条）────────────────────────────────────────
const dragging = ref<{ groupId: string; startX: number; startY: number } | null>(null)

function onTitlePointerDown(event: PointerEvent, groupId: string) {
  if (!props.draggable) return
  if (event.button !== 0) return
  emit('select', groupId)
  dragging.value = { groupId, startX: event.clientX, startY: event.clientY }
  // setPointerCapture 在 jsdom 等无头环境不存在，真机有 ⇒ 判空后安全跳过。
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
}

function onTitlePointerMove(event: PointerEvent) {
  const drag = dragging.value
  if (!drag) return
  const zoom = viewport.value.zoom || 1
  const dx = (event.clientX - drag.startX) / zoom
  const dy = (event.clientY - drag.startY) / zoom
  if (dx === 0 && dy === 0) return
  drag.startX = event.clientX
  drag.startY = event.clientY
  emit('move', drag.groupId, { x: dx, y: dy })
}

function onTitlePointerUp(event: PointerEvent) {
  const drag = dragging.value
  if (!drag) return
  const el = event.currentTarget as HTMLElement
  if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
  dragging.value = null
  emit('move-end', drag.groupId)
}

// ── 重命名（双击标题）─────────────────────────────────────
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

function startRename(group: CanvasGroup) {
  renamingId.value = group.id
  renameDraft.value = group.title
  // select() 在 jsdom 等无头环境不存在，真机有 ⇒ 判空后安全跳过。
  void nextTick(() => renameInputRef.value?.select?.())
}

function commitRename() {
  const id = renamingId.value
  if (!id) return
  const title = renameDraft.value.trim()
  renamingId.value = null
  if (title) emit('rename', id, title)
}
</script>

<template>
  <div class="canvas-group-layer" :style="viewportStyle">
    <div
      v-for="group in groups"
      :key="group.id"
      class="group-node-wrapper"
      :class="{ 'is-active': selectedGroupId === group.id }"
      :style="boxStyle(group)"
    >
      <div
        class="group-drag-handle"
        :style="chipStyle(group.id)"
        @pointerdown.stop="onTitlePointerDown($event, group.id)"
        :class="{ 'is-draggable': draggable }"
        @pointermove.stop="onTitlePointerMove"
        @pointerup.stop="onTitlePointerUp"
        @pointercancel.stop="onTitlePointerUp"
        @dblclick.stop="startRename(group)"
      >
        <input
          v-if="renamingId === group.id"
          ref="renameInputRef"
          v-model="renameDraft"
          class="group-rename-input"
          placeholder="分组名称"
          @keydown.enter.stop="commitRename"
          @keydown.esc.stop="renamingId = null"
          @blur="commitRename"
          @click.stop
          @pointerdown.stop
        >
        <template v-else>
          <span class="group-title-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
              <rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
              <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
              <rect x="13" y="13" width="7.5" height="7.5" rx="2" />
            </svg>
          </span>
          <h4 class="group-title">{{ group.title }}</h4>
          <span class="group-meta">{{ group.childIds.length }} 个节点</span>
          <button
            type="button"
            class="group-ungroup-btn"
            title="解组（移除框，保留节点）"
            aria-label="解组"
            @pointerdown.stop
            @click.stop="emit('ungroup', group.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </template>
      </div>
      <div class="group-node-container" />
      <!-- 四条边的点击热区：框体内部必须 pointer-events:none（否则吃掉子节点点击），
           但「点边框 = 选中分组」是用户最自然的预期；GROUP_PADDING(80px) 保证边框带是空白区，
           不会盖住任何子节点。 -->
      <template v-for="side in (['top', 'right', 'bottom', 'left'] as const)" :key="side">
        <div
          class="group-edge-hit"
          :class="`group-edge-hit--${side}`"
          @pointerdown.stop="emit('select', group.id)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.canvas-group-layer {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

.group-node-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  /* 分组强调色只取一次（--neo-group-accent 由 boxStyle 按 colorKey 注入），
     下面标题条/边框热区各处复用，避免重复消费旧令牌（棘轮只许减）。 */
  --group-accent: var(--neo-group-accent, var(--neo-group-neutral));
}

/* 容器（虚线边框本体，视觉样式在全局 neo-node.css）必须铺满 wrapper：
   旧节点形态靠模板上的 h-full/w-full 撑满节点盒，侧车化重写模板时丢了这个
   撑满 ⇒ 容器塌成 min-height:160px 的一条横带、子节点全部「挂在框外」。
   wrapper 有内联 px 宽高，inset:0 恒等其内容盒（border-box ⇒ 虚线边贴框沿）。 */
.group-node-container {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
}

/* 标题条：贴分组框上沿（与图片/视频节点的 .neo-node-external-title 同位同字体）。
   整条可拖（= 整组平移），双击标题区可重命名。做成实底 chip：分组框可能很大
   （子节点分散），用户需要一眼看出「这是分组标签」而不是残留的选区。 */
.group-drag-handle {
  pointer-events: auto;
  position: absolute;
  top: -32px;
  left: 0;
  right: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  width: max-content;
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--group-accent) 42%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--group-accent) 18%, var(--lnk-surface-overlay));
  backdrop-filter: blur(6px);
}

/* 四边点击热区（仅 12px 宽，落在 80px padding 的空白带内，不遮子节点）。 */
.group-edge-hit {
  position: absolute;
  pointer-events: auto;
  z-index: 1;
  background: transparent;
  transition: background 0.15s ease;
}

.group-edge-hit--top,
.group-edge-hit--bottom {
  left: 0;
  right: 0;
  height: 12px;
}

.group-edge-hit--left,
.group-edge-hit--right {
  top: 0;
  bottom: 0;
  width: 12px;
}

.group-edge-hit--top {
  top: 0;
}

.group-edge-hit--bottom {
  bottom: 0;
}

.group-edge-hit--left {
  left: 0;
}

.group-edge-hit--right {
  right: 0;
}

.group-edge-hit:hover {
  background: color-mix(in srgb, var(--group-accent) 26%, transparent);
}

.group-drag-handle.is-draggable {
  cursor: grab;
}

.group-drag-handle.is-draggable:active {
  cursor: grabbing;
}

.group-drag-handle:hover .group-title {
  color: var(--neo-node-text);
}

/* 标题条右侧 × 解组按钮：让分组无需借助浮层工具条即可移除（解决「框删不掉」）。 */
.group-ungroup-btn {
  pointer-events: auto;
  flex: none;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: 4px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--lnk-hover-overlay);
  color: var(--lnk-text-muted);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.group-ungroup-btn:hover {
  background: var(--lnk-error-bg);
  color: var(--lnk-error);
}

.group-ungroup-btn svg {
  display: block;
  width: 13px;
  height: 13px;
}

.group-title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  align-self: center;
  color: var(--group-accent);
  transition: color 0.15s ease;
}

.group-title-icon svg {
  display: block;
  width: 13px;
  height: 13px;
}

.group-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--neo-node-title-color);
  white-space: nowrap;
  transition: color 0.15s ease;
}

.group-meta {
  font-size: 11px;
  color: var(--neo-node-text-muted);
  opacity: 0.75;
}

.group-rename-input {
  width: 100%;
  border: 1px solid var(--neo-border-strong);
  border-radius: 6px;
  background: var(--neo-hover-bg);
  padding: 1px 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--neo-node-text);
  outline: none;
}

.group-rename-input:focus {
  border-color: var(--neo-accent);
}
</style>
