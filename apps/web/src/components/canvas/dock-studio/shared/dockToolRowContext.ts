import { computed, type ComputedRef, type InjectionKey } from 'vue'
import type { SelectionToolDef } from '@/components/canvas/selectionToolModel'
import { TOOL_ICON_ELEMENT, TOOL_ICON_INPAINT, TOOL_ICON_MATTING, TOOL_ICON_OUTPAINT } from '@/components/canvas/toolIcons'

/**
 * 选中节点快捷工具行（2026-10-18 方案 A）：节点上沿浮层（SelectionActionBar）退役，
 * 工具行收进 studio dock 卡片 header 行中段（DockToolbarShell #header-mid）——
 * 图标底部不超出 header 下沿，dock 总高度与「有引用芯片缩略图」态持平。
 * DockStudioToolbar 持有数据与动作（provide），ImageDockPanel 消费渲染（inject），
 * 免去 Toolbar→Router→Panel 三层 props/emits 透传。
 */
export interface DockToolRowContext {
  visible: ComputedRef<boolean>
  tools: ComputedRef<SelectionToolDef[]>
  gridSlice: ComputedRef<boolean>
  gridSliceLoading: ComputedRef<boolean>
  gridSliceDisabled: ComputedRef<boolean>
  gridSliceDisabledTitle: ComputedRef<string>
  gridSliceImage: ComputedRef<{ width: number; height: number } | null>
  mattingBusy: ComputedRef<boolean>
  onToolClick: (tool: SelectionToolDef) => void
  onSlice: (cols: number, rows: number) => void
  onOpenCustom: () => void
}

export const DOCK_TOOL_ROW_KEY: InjectionKey<DockToolRowContext> = Symbol('dock-tool-row')

/** 兜底空实现（未在 DockStudioToolbar 之下渲染时工具行整体不可见） */
export const DOCK_TOOL_ROW_DEFAULT: DockToolRowContext = {
  visible: computed(() => false),
  tools: computed(() => []),
  gridSlice: computed(() => false),
  gridSliceLoading: computed(() => false),
  gridSliceDisabled: computed(() => false),
  gridSliceDisabledTitle: computed(() => ''),
  gridSliceImage: computed(() => null),
  mattingBusy: computed(() => false),
  onToolClick: () => {},
  onSlice: () => {},
  onOpenCustom: () => {},
}

/** 工具图标 path 库（自旧 SelectionActionBar 迁入，path 原样保留） */
export const DOCK_TOOL_ICONS: Record<string, string> = {
  refine: '<path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />',
  matting: TOOL_ICON_MATTING,
  outpaint: TOOL_ICON_OUTPAINT,
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" />',
  inpaint: TOOL_ICON_INPAINT,
  element: TOOL_ICON_ELEMENT,
  annotate: '<path d="M12 20h9" /><path d="M5 17 17.5 4.5a2.12 2.12 0 0 1 3 3L8 20l-4 1 1-4Z" /><path d="M13 6.5l3.5 3.5" />',
  rotate: '<path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" />',
  'save-asset': '<rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 8v8" /><path d="M8 12h8" />',
}
