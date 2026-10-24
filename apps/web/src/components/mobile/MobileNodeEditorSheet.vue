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
  /**
   * R4-T2：透传 `DockStudioRouter` 的 `generate`。
   *
   * ⭐ 断链修复：原先只接了 `patch` / `close` ⇒ `DockStudioRouter` 声明的
   *   `generate` / `removeRef` / `continueShot` / `refine` 四个 emit **被丢弃**
   *   ⇒ 移动端在编辑 sheet 里改完提示词**点「生成」毫无反应**（dock panel 的
   *   `onGenerate` 先 emit patch 再 emit generate，后半段被吞）。
   */
  generate: []
  /** R4-T2：透传 `removeRef`（移动端编辑 sheet 里可删引用芯片） */
  removeRef: [ref: NodeRef]
}>()
</script>

<template>
  <div class="mobile-editor-sheet" role="dialog" aria-modal="true" aria-label="编辑节点">
    <div class="mobile-editor-head">
      <span class="mobile-editor-title">编辑</span>
      <!-- 走查④⑤（2026-10-24）：全屏编辑器的唯一关闭入口。
           原先是左上角一枚「▾」——语义模糊（像折叠不像关闭），真机走查反馈
           「无法关闭回去 / 右上角没有 x」。改为平台惯例的右上角 X，44px 触控目标。 -->
      <button
        class="sheet-close"
        type="button"
        aria-label="关闭"
        data-action="close"
        data-testid="mobile-editor-close"
        @click="emit('close')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <div class="mobile-editor-body">
      <DockStudioRouter
        :node="node"
        :upstream="(upstream as any)"
        :refs="refs"
        :mentions="mentions"
        :generating="generating"
        @patch="(p: Record<string, unknown>) => emit('patch', p)"
        @remove-ref="(r: NodeRef) => emit('removeRef', r)"
        @generate="emit('generate')"
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
  justify-content: space-between;
  gap: var(--lnk-space-2);
  min-height: var(--lnk-touch-target);
  padding: calc(var(--lnk-space-2) + env(safe-area-inset-top)) var(--lnk-pad-card) var(--lnk-space-2);
  border-bottom: 1px solid var(--lnk-divider);
}

/* 右上角 X（走查⑤）：44px 触控目标 + 按下反馈 */
.sheet-close {
  flex: none;
  display: inline-flex;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-secondary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.sheet-close:active {
  background: var(--lnk-pressed-overlay);
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

/* ── 走查⑥：参数选择器移动端化（2026-10-24 真机走查）───────────────────
 * 现象：四个节点类型的 studio dock 里，模型 / 尺寸 / 视频 / 音频参数选择
 * 「点击不能弹出，不可用」。
 *
 * 根因（代码级）：这些选择器是 PC popover——弹层绝对定位，包含块是**触发器
 * 外层的小 `.relative` 盒**（只包住那个 chip）。而移动端两条既有规则叠加：
 *   ① neo-node.css 767px：`.bottom-toolbar-actions > *:first-child { overflow: hidden }`
 *      （Round2 为模型 chip 省略号加的）——模型弹层是它的子元素 ⇒ **整块被裁剪**；
 *   ② 同媒体查询 `.dock-inline-card { left/right: 12px }` 是照「包含块=面板」的
 *      错觉写的，实际包含块是 ~88px 的 chip 盒 ⇒ 尺寸弹层被压成 ~64px 宽。
 *   （Round2 只断言了 CSS 字符串存在，没做真机渲染 ⇒ 这两个坑一直带到了 R1 的
 *    全屏编辑 sheet 里。VideoSettingsSelector / AudioVoiceSettingsSelector /
 *    VoiceModelSelector 更连 dock-inline-card 都没挂，窄屏直接右溢出。）
 *
 * 修法：在**本 sheet 作用域内**把面板弹层统一改为贴底卡片（移动端 sheet 惯例）：
 *   - 先摘 `.bottom-toolbar-container` 的 backdrop-filter：它会使 fixed 的包含块
 *     变成面板而非视口（panel 是不透明全屏 sheet，玻璃模糊本就无可模糊）；
 *   - 弹层 fixed 贴视口底部、通宽、72vh 封顶内部滚 —— 不再被小盒裁剪/挤压；
 *   - 触发器 wrapper 恢复 overflow: visible（弹层需要溢出显示；chip 省略号
 *     由内部的 max-width/truncate 自己保证，不依赖外层裁剪）。
 * ⛔ PC 零 diff：以上全部 `:deep()` 限定在 `.mobile-editor-sheet` 内，
 *   桌面浮动 Dock（DockStudioToolbar）不走本组件。 */
.mobile-editor-sheet :deep(.bottom-toolbar-container) {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.mobile-editor-sheet :deep(.bottom-toolbar-actions > *),
.mobile-editor-sheet :deep(.bottom-toolbar-actions > *:first-child) {
  overflow: visible;
}

/* chip 省略改由内部 truncate 自己完成：min-width:0 让弹性子项可收缩，
   不再依赖外层 overflow:hidden——那会把弹层一起裁掉（走查⑥ 根因①）。 */
.mobile-editor-sheet :deep(.bottom-toolbar-actions > *:first-child button),
.mobile-editor-sheet :deep(.bottom-toolbar-actions > *:first-child button > *) {
  min-width: 0;
}

.mobile-editor-sheet :deep(.neo-popover) {
  position: fixed !important;
  inset: auto 0 0 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  top: auto !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  max-height: 72vh !important;
  margin: 0 !important;
  border-radius: 20px 20px 0 0 !important;
  padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)) !important;
  overflow-y: auto !important;
  overscroll-behavior: contain;
  z-index: 300 !important;
}
</style>
