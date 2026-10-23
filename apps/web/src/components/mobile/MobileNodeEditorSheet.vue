<script setup lang="ts">
import DockStudioRouter from '@/components/canvas/dock-studio/DockStudioRouter.vue'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { UpstreamNodeContext } from '@/composables/useUpstreamNodeContext'
import type { MentionOption } from '@/components/canvas/MentionInput.vue'
import type { NodeRef } from '@/composables/useNodeRefs'

/**
 * 移动端节点编辑 sheet（2026-10-22 R1-T5）：移除了浮动 Dock 后，承接「编辑」动作的落点。
 * 直接复用桌面参数面板真源 `DockStudioRouter`，保证移动端编辑能力与 PC 一致，不另起一套。
 * 审阅焦点 #3：DockStudioRouter 仅依赖 props（node/upstream/refs/mentions/generating），
 * 不依赖任何父级 provide；因此本 sheet 只透传 props 即可挂载，无上下文缺失风险。
 */
withDefaults(
  defineProps<{
    node: EditableFlowNode
    upstream?: UpstreamNodeContext
    refs?: NodeRef[]
    mentions?: MentionOption[]
    generating?: boolean
  }>(),
  {
    // 审阅焦点 #3：DockStudioRouter 内部 ImageDockPanel/VideoDockPanel 直接访问
    // upstream.referenceImageUrl 等字段，upstream 为 undefined 会崩。本 sheet 必须
    // 永远补一个合法空上下文，保证移动端编辑器挂载不抛错（与 CanvasPage editorUpstream 一致）。
    upstream: () => ({
      textPrompt: '',
      referenceImageUrl: '',
      referenceImageNodeId: null,
      textNodeIds: [],
      lastFrameUrl: '',
      lastFrameVideoNodeId: null,
    }),
    refs: () => [],
    mentions: () => [],
    generating: false,
  },
)
const emit = defineEmits<{
  close: []
  patch: [patch: Record<string, unknown>]
}>()
</script>

<template>
  <div class="mobile-editor-sheet" role="dialog" aria-modal="true" aria-label="编辑节点">
    <div class="mobile-editor-head">
      <button class="sheet-handle" type="button" aria-label="关闭" data-action="close" @click="emit('close')">
        ▾
      </button>
      <span class="mobile-editor-title">编辑</span>
    </div>
    <div class="mobile-editor-body">
      <DockStudioRouter
        :node="node"
        :upstream="(upstream as any)"
        :refs="refs"
        :mentions="mentions"
        :generating="generating"
        @patch="(p: Record<string, unknown>) => emit('patch', p)"
        @close="emit('close')"
      />
    </div>
  </div>
</template>

<style scoped>
.mobile-editor-sheet {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: flex;
  flex-direction: column;
  background: var(--lnk-surface-canvas);
  box-sizing: border-box;
}

.mobile-editor-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
  min-height: var(--lnk-touch-target);
  padding: calc(var(--lnk-space-2) + env(safe-area-inset-top)) var(--lnk-pad-card) var(--lnk-space-2);
  border-bottom: 1px solid var(--lnk-divider);
}

.sheet-handle {
  flex: none;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--lnk-text-secondary);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mobile-editor-title {
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
}

.mobile-editor-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
</style>
