<script setup lang="ts">
/**
 * ADR-0011 T1（2026-10-19）：`pending_confirm` 节点内联确认面。
 *
 * 背景：propose 待确认态曾被渲染成「对话卡 + 画布节点 + 自动弹出的 studio dock」
 * 三带叠罗汉（ADR-0011），确认入口实际藏在 dock 生成按钮里。本组件把「确认 / 取消 /
 * 编辑」贴到待确认节点上，成为**单一锚定表面**；dock 改由 T4 门控不自动弹。
 *
 * 行为同源（不新造第二套确认语义）：
 * - 确认 → host 调 `handleAgentGenerateNode`（内含 confirmProposeWait → POST /answers）；
 * - 取消 → host 调 `AgentSideRail.cancelProposeForNode`（POST /answers {decline} +
 *   clearProposeGeneration），与侧栏取消同一函数；
 * - 编辑 → host 置编辑意图开 dock（改提示词 / 参数后仍走同一确认路径）。
 *
 * 定位：屏幕空间浮层（不随画布缩放，同 MultiSelectToolbarOverlay 家族），
 * 默认锚节点上方，顶部空间不足翻转到下方（data-anchor 暴露当前锚点供测试）。
 * 位置走 computed（viewport / nodes 响应式驱动），不引入 raf / resize 机制。
 */
import { computed } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { getSelectionFrame } from '@/composables/useCanvasGrouping'
import { NODE_PENDING_CONFIRM_STATUS } from '@/constants/dockStudio'

/** 结构入参：只依赖定位与状态字段，便于单测构造（不拖 EditableFlowNode 全类型）。 */
type ProposeConfirmNodeLike = {
  id: string
  data?: { status?: unknown } | null
} | null

const props = defineProps<{
  node: ProposeConfirmNodeLike
}>()

const emit = defineEmits<{
  confirm: [nodeId: string]
  cancel: [nodeId: string]
  edit: [nodeId: string]
}>()

const { viewport, nodes: flowNodes } = useVueFlow()

/** 浮层估算高度（px，屏幕空间）：上方翻转判定用（条高 ~32 + 上下留白）。 */
const BAR_HEIGHT = 40
const EDGE_MARGIN = 8

/** 屏幕空间锚点：默认节点上方；上方空间不足（贴顶 / 缩小）翻转到下方。 */
const layout = computed<{ anchor: 'above' | 'below'; x: number; y: number } | null>(() => {
  const node = props.node
  if (!node?.id) return null
  const frame = getSelectionFrame(flowNodes.value, [node.id])
  if (!frame) return null
  const zoom = viewport.value.zoom
  const x = frame.centerX * zoom + viewport.value.x
  const aboveTop = frame.minY * zoom + viewport.value.y - BAR_HEIGHT - EDGE_MARGIN
  if (aboveTop >= EDGE_MARGIN) return { anchor: 'above', x, y: aboveTop }
  return { anchor: 'below', x, y: frame.bottomY * zoom + viewport.value.y }
})

/** 双重守卫：host 已按状态门控，组件自身不渲染非待确认态（防 prop 竞态残留）。 */
const visible = computed(() => {
  const node = props.node
  if (!node?.id) return false
  return String(node.data?.status ?? '') === NODE_PENDING_CONFIRM_STATUS
})

function emitAction(kind: 'confirm' | 'cancel' | 'edit') {
  const id = props.node?.id
  if (id) emit(kind, id)
}
</script>

<template>
  <div
    v-if="visible && layout"
    class="propose-confirm-overlay pointer-events-none absolute z-[47]"
    :data-anchor="layout.anchor"
    data-testid="propose-confirm-overlay"
    :style="{
      left: `${layout.x}px`,
      top: `${layout.y}px`,
      transform: 'translate(-50%, 0)',
    }"
  >
    <div
      class="propose-confirm-bar neo-chrome pointer-events-auto flex items-center gap-1.5 rounded-xl px-2 py-1.5"
      @click.stop
    >
      <span class="propose-confirm-dot" aria-hidden="true" />
      <span class="propose-confirm-label">待确认</span>
      <button
        type="button"
        class="propose-confirm-btn accent"
        data-testid="propose-confirm-confirm"
        aria-label="确认生成"
        title="按提议的提示词与参数开始生成"
        @click="emitAction('confirm')"
      >
        <svg viewBox="0 0 16 16" class="propose-confirm-ico" aria-hidden="true">
          <path d="M9 1 3 9h4l-1 6 6-8H8l1-6z" fill="currentColor" stroke="none" />
        </svg>
        <span>确认生成</span>
      </button>
      <button
        type="button"
        class="propose-confirm-btn"
        data-testid="propose-confirm-edit"
        aria-label="编辑提示词"
        title="修改提示词 / 参数后再确认"
        @click="emitAction('edit')"
      >
        <svg viewBox="0 0 16 16" class="propose-confirm-ico" aria-hidden="true">
          <path d="M11.5 1.8a1.7 1.7 0 0 1 2.4 2.4L5.6 12.5 2 13.4l.9-3.6 8.6-8z" />
        </svg>
        <span>编辑</span>
      </button>
      <button
        type="button"
        class="propose-confirm-btn"
        data-testid="propose-confirm-cancel"
        aria-label="取消生成提议"
        title="拒绝这次生成提议（节点回到草稿，对话继续）"
        @click="emitAction('cancel')"
      >
        <span>取消</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 视觉语言对齐 MultiSelectToolbar（同族浮层）：neo-chrome 底 + --neo-* 令牌，
   颜色不新增 hex/rgba（theme-usage 棘轮 + design-token 纪律）。 */
.propose-confirm-bar {
  box-shadow: var(--lnk-shadow-md);
}
.propose-confirm-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 9999px;
  background: var(--lnk-warning);
}
.propose-confirm-label {
  padding: 0 2px;
  font-size: 12px;
  color: var(--neo-text-muted);
}
.propose-confirm-btn {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 12px;
  color: var(--neo-text-secondary);
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.propose-confirm-btn:hover {
  background: var(--neo-hover-bg);
  color: var(--neo-text-primary);
}
.propose-confirm-btn.accent {
  color: var(--neo-accent-text);
}
.propose-confirm-btn.accent:hover {
  background: var(--neo-accent-soft);
  color: var(--neo-accent-text);
}
.propose-confirm-ico {
  display: block;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
