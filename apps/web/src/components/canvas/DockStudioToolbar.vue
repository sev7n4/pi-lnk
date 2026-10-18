<script setup lang="ts">
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { UpstreamNodeContext } from '@/composables/useUpstreamNodeContext'
import type { MentionOption } from '@/components/canvas/MentionInput.vue'
import DockStudioRouter from '@/components/canvas/dock-studio/DockStudioRouter.vue'
import { EDITABLE_NODE_TYPES } from '@/composables/useSelectedNodeEditor'
import { computed, onMounted, onUnmounted, provide, ref } from 'vue'
import { isNodeGenerating } from '@/constants/dockStudio'
import type { CompositionTrack } from '@/utils/compositionUpstream'
import type { NodeRef } from '@/composables/useNodeRefs'
import { buildSelectionTools, type SelectionToolDef } from './selectionToolModel'
import { DOCK_TOOL_ROW_KEY } from './dock-studio/shared/dockToolRowContext'

const props = withDefaults(defineProps<{
  node: EditableFlowNode | null
  upstream: UpstreamNodeContext
  refs?: NodeRef[]
  compositionTracks?: CompositionTrack[]
  mentions?: MentionOption[]
  generating?: boolean
  scale?: number
  /** 收缩态（节点编辑浮层激活时）：收起 dock 只留底部触发热区，悬停展开、划走收回（2026-09-25 用户拍板）。 */
  collapsed?: boolean
  /** ---- 选中节点快捷工具行（2026-10-18 方案 A：节点上沿浮层退役并入此处）---- */
  toolRowVisible?: boolean
  gridSlice?: boolean
  gridSliceLoading?: boolean
  gridSliceDisabled?: boolean
  gridSliceDisabledTitle?: string
  /** 宫格切分原图像素尺寸；用于 64px 单格下限禁用判定 */
  gridSliceImage?: { width: number; height: number } | null
  /** 文件组（下载/存库）是否可用：节点有可访问的 url 时为真 */
  hasUrl?: boolean
  /** 一键抠图进行中：matting 按钮禁用 + loading（防重入） */
  mattingBusy?: boolean
}>(), {
  generating: false,
  collapsed: false,
  toolRowVisible: false,
  gridSlice: false,
  gridSliceLoading: false,
  gridSliceDisabled: false,
  gridSliceDisabledTitle: '',
  hasUrl: false,
  mattingBusy: false,
})

const emit = defineEmits<{
  patch: [patch: Record<string, unknown>]
  removeRef: [ref: NodeRef]
  generate: []
  close: []
  upload: [file: File]
  convert: [targetType: 'image' | 'video' | 'audio']
  save: []
  expand: []
  batchGenerate: []
  export: []
  continueShot: []
  refine: []
  /** ---- 快捷工具行 ---- */
  edit: []
  slice: [cols: number, rows: number]
  'open-custom': []
  download: []
  'save-asset': []
  matting: []
  crop: []
  outpaint: []
  inpaint: []
  'element-edit': []
  annotate: []
}>()

/** 悬停展开（仅收缩态有意义；生成中/锁定态不收缩） */
const hoverOpen = ref(false)

/** 收缩生效条件：宿主要求收缩 && 非生成中 && 未被悬停展开 */
const collapsedNow = computed(() => props.collapsed && !props.generating && !hoverOpen.value)

const visible = computed(() => {
  if (!props.node) return false
  return EDITABLE_NODE_TYPES.has(String(props.node.type ?? ''))
})

const dockScale = computed(() => {
  const value = props.scale ?? 1
  return Math.min(2, Math.max(0.8, value))
})

const dockStyle = computed(() => ({
  transform: `scale(${dockScale.value})`,
  transformOrigin: 'bottom center',
}))

const dockLocked = computed(() => {
  if (props.generating) return true
  const status = props.node?.data?.status
  return isNodeGenerating(status) || status === 'uploading'
})

/** 快捷工具编排：config 驱动 + 抠图进行中禁用（与旧 SelectionActionBar 行为一致） */
const tools = computed(() =>
  buildSelectionTools({ hasUrl: Boolean(props.hasUrl) }).map((tool) =>
    tool.id === 'matting' && props.mattingBusy
      ? { ...tool, disabled: true, disabledReason: '抠图进行中' }
      : tool,
  ),
)

function onToolClick(tool: SelectionToolDef) {
  if (tool.disabled) return
  if (tool.id === 'refine') emit('edit')
  else if (tool.id === 'matting') emit('matting')
  else if (tool.id === 'crop') emit('crop')
  else if (tool.id === 'outpaint') emit('outpaint')
  else if (tool.id === 'inpaint') emit('inpaint')
  else if (tool.id === 'element-edit') emit('element-edit')
  else if (tool.id === 'annotate') emit('annotate')
  else if (tool.id === 'download') emit('download')
  else if (tool.id === 'save-asset') emit('save-asset')
}

/** 工具行数据/动作下发：ImageDockPanel 在 dock 卡 header 中段渲染（inject 消费） */
provide(DOCK_TOOL_ROW_KEY, {
  visible: computed(() => props.toolRowVisible && !collapsedNow.value),
  tools,
  gridSlice: computed(() => props.gridSlice),
  gridSliceLoading: computed(() => props.gridSliceLoading),
  gridSliceDisabled: computed(() => props.gridSliceDisabled),
  gridSliceDisabledTitle: computed(() => props.gridSliceDisabledTitle),
  gridSliceImage: computed(() => props.gridSliceImage ?? null),
  mattingBusy: computed(() => props.mattingBusy),
  onToolClick,
  onSlice: (cols: number, rows: number) => emit('slice', cols, rows),
  onOpenCustom: () => emit('open-custom'),
})

function handleDockEscape(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  if (event.key === 'Escape' && visible.value) emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', handleDockEscape)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleDockEscape)
})
</script>

<template>
  <Transition name="dock-studio">
    <div
      v-if="visible"
      class="dock-studio-toolbar pointer-events-none absolute inset-x-0 bottom-3 z-[45] flex justify-center px-4"
      :class="{ 'is-dock-locked': dockLocked }"
    >
      <!-- 收缩态：底部触发热区（悬停展开）+ 呼吸指示点 -->
      <div
        v-if="collapsedNow"
        class="dock-studio-hit pointer-events-auto absolute inset-x-0 -bottom-1 flex h-8 items-end justify-center"
        data-testid="dock-hit"
        @mouseenter="hoverOpen = true"
      >
        <span class="dock-studio-hit__pill" aria-hidden="true" />
      </div>
      <!-- 展开态（常态 / 收缩态被悬停展开）：划走（鼠标离开 dock 卡）自动收回 -->
      <div
        v-else
        class="pointer-events-none flex w-full justify-center"
        :style="dockStyle"
      >
        <div class="pointer-events-auto" data-testid="dock-body" @mouseleave="hoverOpen = false">
          <DockStudioRouter
            :node="node"
            :upstream="upstream"
            :refs="refs"
            :composition-tracks="compositionTracks"
            :mentions="mentions"
            :generating="generating"
            @patch="emit('patch', $event)"
            @remove-ref="emit('removeRef', $event)"
            @generate="emit('generate')"
            @close="emit('close')"
            @upload="emit('upload', $event)"
            @convert="emit('convert', $event)"
            @save="emit('save')"
            @expand="emit('expand')"
            @batch-generate="emit('batchGenerate')"
            @export="emit('export')"
            @continue-shot="emit('continueShot')"
            @refine="emit('refine')"
          />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.dock-studio-enter-active,
.dock-studio-leave-active {
  transition: opacity 0.35s cubic-bezier(0.22, 1, 0.36, 1), transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}
.dock-studio-enter-from,
.dock-studio-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.96);
}

.dock-studio-hit__pill {
  width: 36px;
  height: 4px;
  margin-bottom: 4px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--neo-text) 28%, transparent);
  transition: background 0.2s ease, width 0.2s ease;
}
.dock-studio-hit:hover .dock-studio-hit__pill {
  width: 56px;
  background: color-mix(in srgb, var(--neo-text) 48%, transparent);
}

/* ---- 移动端：抬高到 composer 贴底容器之上（2026-10-18 真机反馈）----
 * 画布视图下 composer（SSE 流 + 裸条）fixed 贴底 z-70，本 dock bottom-3 z-45 会被盖住。
 * AgentSideRail 用 ResizeObserver 把贴底容器实测高度发布为 --lnk-agent-dock-h
 * （键盘/参数行变化自动跟随），这里按它清位；桌面端变量恒 0 → 维持 bottom-3 原位。
 * 方案 A 后 has-studio-dock 态 composer 面板整体隐藏 → 变量趋 0，dock 自然落底。 */
@media (max-width: 767px) {
  .dock-studio-toolbar {
    bottom: calc(var(--lnk-agent-dock-h, 0px) + env(safe-area-inset-bottom, 0px) + 12px);
  }
}
</style>
