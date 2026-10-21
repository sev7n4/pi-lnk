<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue'
import { Handle, Position, useNode } from '@vue-flow/core'
import {
  getNeoNodeMeta,
  resolveNeoNodeStatus,
  resolveNeoNodeTitle,
  type NeoNodeStatus,
} from '@/components/canvas/neoNodeMeta'
import { useLongPress } from '@/composables/useLongPress'
import {
  CANVAS_MULTI_SELECT_ACTIVE_KEY,
  CANVAS_NODE_ADD_AGENT_KEY,
  CANVAS_NODE_CLICK_GUARD_KEY,
  CANVAS_NODE_LOCATE_FLASH_KEY,
  CANVAS_NODE_OPEN_CONTEXT_MENU_KEY,
  CANVAS_NODE_RENAME_KEY,
  CANVAS_NODE_RENAME_REQUEST_KEY,
  CANVAS_REF_PICK_ACTIVE_KEY,
  CANVAS_REF_PICK_NODE_IDS_KEY,
  CANVAS_REF_PICK_REJECT_KEY,
} from '@/composables/canvasNodeActions'
import CanvasRefTargetIcon from '@/components/shared/CanvasRefTargetIcon.vue'
import { incompleteBadgeLabel, isIncompleteNode } from '@/utils/incompleteNode'

const props = withDefaults(
  defineProps<{
    selected?: boolean
    nodeType: string
    data?: Record<string, unknown>
    title?: string
    status?: NeoNodeStatus | string
    width?: number | string
    height?: number | string
    hideTargetHandle?: boolean
    hideSourceHandle?: boolean
    targetPosition?: Position
    sourcePosition?: Position
  }>(),
  {
    selected: false,
    hideTargetHandle: false,
    hideSourceHandle: false,
    targetPosition: Position.Left,
    sourcePosition: Position.Right,
  },
)

const meta = computed(() => getNeoNodeMeta(props.nodeType))
const displayTitle = computed(() => props.title ?? resolveNeoNodeTitle(props.nodeType, props.data))
const nodeStatus = computed(() => {
  if (props.status) return resolveNeoNodeStatus(String(props.status))
  return resolveNeoNodeStatus(String(props.data?.status ?? ''))
})

/**
 * 「未完成」态（批次 3.1）。
 *
 * ⭐ 放在**节点公共外壳**这里 ⇒ 一处覆盖全部 10 种节点类型
 * （image/video/text/audio/shot/director/composition/world/prompt/input）。
 *
 * 口径：`data.status === 'incomplete'`（后端在回合中断时写入的事实标记）。
 * ⚠️ 它**不是**「生成中」：后台生成任务可能仍在跑，但那一轮已中断 ⇒
 * 展示层要说「未完成」，dock 门控等逻辑仍按非生成态处理。
 */
const isIncomplete = computed(() => isIncompleteNode(props.data))
const incompleteBadge = computed(() => (isIncomplete.value ? incompleteBadgeLabel(props.data) : ''))

const shellStyle = computed(() => {
  const width = props.width ?? meta.value.defaultWidth
  const height = props.height ?? meta.value.defaultHeight
  return {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
  }
})

const { id: nodeId } = useNode()
const renameNode = inject(CANVAS_NODE_RENAME_KEY, null)
const addToAgent = inject(CANVAS_NODE_ADD_AGENT_KEY, null)
const openContextMenu = inject(CANVAS_NODE_OPEN_CONTEXT_MENU_KEY, null)
const clickGuard = inject(CANVAS_NODE_CLICK_GUARD_KEY, null)
const multiSelectActive = inject(CANVAS_MULTI_SELECT_ACTIVE_KEY, ref(false))
const pickActive = inject(CANVAS_REF_PICK_ACTIVE_KEY, ref(false))
const pickedNodeIds = inject(CANVAS_REF_PICK_NODE_IDS_KEY, ref(new Set<string>()))
const pickRejectNodeId = inject(CANVAS_REF_PICK_REJECT_KEY, ref<string | null>(null))
const isPickMarked = computed(() => pickedNodeIds.value.has(nodeId))
const isPickReject = computed(() => pickRejectNodeId.value === nodeId)
const locateFlashNodeIds = inject(CANVAS_NODE_LOCATE_FLASH_KEY, ref(new Set<string>()))
const isLocateFlashing = computed(() => locateFlashNodeIds.value.has(nodeId))
const isHovered = ref(false)
let hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null

function setHovered(next: boolean) {
  if (hoverLeaveTimer) {
    clearTimeout(hoverLeaveTimer)
    hoverLeaveTimer = null
  }
  if (next) {
    isHovered.value = true
    return
  }
  hoverLeaveTimer = setTimeout(() => {
    isHovered.value = false
    hoverLeaveTimer = null
  }, 80)
}

const showHandles = computed(() => props.selected || isHovered.value)
const isRenaming = ref(false)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

function startRename() {
  if (!renameNode) return
  isRenaming.value = true
  renameDraft.value = displayTitle.value
  void nextTick(() => renameInputRef.value?.select())
}

function commitRename() {
  if (!renameNode || !isRenaming.value) return
  const title = renameDraft.value.trim()
  if (title) renameNode(nodeId, title)
  isRenaming.value = false
}

function cancelRename() {
  isRenaming.value = false
}

/** 行内重命名请求（D-6）：长按 sheet「重命名」→ 页面级置 nodeId → 本节点打开输入态 */
const renameRequest = inject(CANVAS_NODE_RENAME_REQUEST_KEY, ref<string | null>(null))
watch(renameRequest, (id) => {
  if (id && id === nodeId) {
    renameRequest.value = null
    startRename()
  }
})

function onAddToAgent(event: MouseEvent) {
  event.stopPropagation()
  addToAgent?.(nodeId)
}

/** 长按节点（2026-10-19 D-6）：统一上下文 sheet 入口，与 PC 右键菜单同源。
 *  触发即标记 click 抑制窗——避免「长按出菜单 → 松手又选中节点打开 dock」。 */
const { bindings: longPressBindings } = useLongPress(() => {
  if (!openContextMenu) return
  clickGuard?.markSuppressed()
  openContextMenu(nodeId)
})
</script>

<template>
  <div
    class="neo-node-wrapper"
    :class="{
      'is-active': selected,
      'show-handles': showHandles,
      'is-hovered': isHovered,
      'is-ref-pick-active': pickActive,
      'is-ref-pick-marked': isPickMarked,
      'is-ref-pick-reject': isPickReject,
      'is-multi-selected': multiSelectActive && selected,
    }"
    @touchstart="longPressBindings.onTouchstart"
    @touchmove="longPressBindings.onTouchmove"
    @touchend="longPressBindings.onTouchend"
    @touchcancel="longPressBindings.onTouchcancel"
    @mouseenter="setHovered(true)"
    @mouseleave="setHovered(false)"
  >
    <!-- 多选模式勾选徽标（D-4）：仅在应用层多选态显示，PC 不渲染 -->
    <span v-if="multiSelectActive && selected" class="neo-node-multi-badge" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4">
        <path d="M3.5 8.5l3 3 6-7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
    <div
      class="neo-node-external-title"
      @dblclick.stop="startRename"
      @mouseenter="setHovered(true)"
      @mouseleave="setHovered(false)"
    >
      <div class="neo-node-icon" :class="meta.variant">
        <svg v-if="meta.icon === 'prompt'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        <svg v-else-if="meta.icon === 'text'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <svg v-else-if="meta.icon === 'image'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2.5" y="3" width="19" height="18" rx="3" />
          <circle cx="8" cy="9" r="2" />
          <path d="M21.5 15.5l-5-5L4 21" />
        </svg>
        <svg v-else-if="meta.icon === 'video'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
        <svg v-else-if="meta.icon === 'audio'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
        <svg v-else-if="meta.icon === 'input'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="4" />
        </svg>
      </div>
      <input
        v-if="isRenaming"
        ref="renameInputRef"
        v-model="renameDraft"
        class="neo-node-rename-input"
        @keydown.enter.stop="commitRename"
        @keydown.esc.stop="cancelRename"
        @blur="commitRename"
        @click.stop
        @mousedown.stop
      >
      <span v-else class="neo-node-title min-w-0 flex-1 truncate">{{ displayTitle }}</span>
      <span class="neo-node-status shrink-0" :class="nodeStatus" />
      <!-- 未完成角标（批次 3.1）：回合中断时该节点没跑完 ⇒ 用户直接看得见「卡在哪」 -->
      <span
        v-if="isIncomplete"
        class="neo-node-incomplete-badge nodrag nopan"
        data-testid="node-incomplete-badge"
        :title="incompleteBadge"
      >{{ incompleteBadge }}</span>
      <button
        v-if="addToAgent"
        type="button"
        class="neo-node-agent-add neo-node-agent-add--title shrink-0"
        title="加入 Agent 引用"
        aria-label="加入 Agent 引用"
        @click="onAddToAgent"
        @mousedown.stop
      >
        <CanvasRefTargetIcon :size="13" />
      </button>
    </div>

    <div
      class="neo-node"
      :class="[
        meta.variant,
        { selected, 'neo-node-locate-flash': isLocateFlashing, 'neo-node-incomplete': isIncomplete },
      ]"
      :style="shellStyle"
    >
      <div class="neo-node-content">
        <slot />
      </div>
    </div>

    <div
      v-if="$slots.footer"
      class="neo-node-external-footer"
      @mouseenter="setHovered(true)"
      @mouseleave="setHovered(false)"
    >
      <slot name="footer" />
    </div>

    <Handle
      v-if="!hideTargetHandle"
      id="target"
      type="target"
      :position="targetPosition"
      class="neo-flow-handle"
    >
      <div class="handle-hitbox" />
      <div class="handle-plus">
        <div class="handle-plus-inner" />
      </div>
    </Handle>
    <Handle
      v-if="!hideSourceHandle"
      id="source"
      type="source"
      :position="sourcePosition"
      class="neo-flow-handle"
    >
      <div class="handle-hitbox" />
      <div class="handle-plus">
        <div class="handle-plus-inner" />
      </div>
    </Handle>
  </div>
</template>

<style scoped>
/*
 * 批次 3.1：「未完成」态的视觉。
 *
 * ⭐ 颜色全部消费 --lnk-* 语义令牌（neoUsageRatchet 棘轮：新代码禁 --neo-*）。
 * ⚠️ 描边用 **outline** 而不是 border：节点的 border 由各节点自己的卡片样式承担
 * （`.neo-gen-card` 等），此处加 border 会改变盒模型 → 卡片尺寸跳动。
 * outline 不参与布局 ⇒ 零位移。
 */
.neo-node-incomplete {
  outline: 1px dashed var(--lnk-warning-border);
  outline-offset: -1px;
}

/*
 * 角标：放在标题行（状态点旁）。
 * ⚠️ 不放在卡片右上角 —— 那里已被 `.neo-task-chrome`（重试/取消）占据（top:8px; right:8px）。
 */
.neo-node-incomplete-badge {
  flex: none;
  max-width: 60%;
  padding: 1px 6px;
  overflow: hidden;
  border: 1px solid var(--lnk-warning-border);
  border-radius: 9999px;
  background: var(--lnk-warning-bg);
  font-size: 10px;
  line-height: 15px;
  color: var(--lnk-warning);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
