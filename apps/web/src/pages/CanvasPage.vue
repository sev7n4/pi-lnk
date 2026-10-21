<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, provide, watch, h, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  VueFlow,
  Panel,
  SelectionMode,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeMouseEvent,
  type NodeChange,
  type EdgeChange,
  type NodeDragEvent,
  type OnConnectStartParams,
  type EdgeMouseEvent,
} from '@vue-flow/core'
import type { DockNodeType } from '@/components/canvas/NodePanelDock.vue'
import { Background } from '@vue-flow/background'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/minimap/dist/style.css'
import type { Session, CanvasAction, ImageVersionEntry, PlanSelectionGenerateResult, CanvasGroup } from '@lnkpi/shared'
import { seedImageVersions, planSelectionGenerate, SelectionBatchLimitError, SelectionBatchPendingConfirmError } from '@lnkpi/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import { useCanvasEditorStore } from '@/stores/canvasEditor'
import { applyActionsToFlow, extrasForCanvasSave, flowToCanvasData } from '@/composables/useCanvasActions'
import { annotateEdgesForSelection } from '@/utils/edgeHighlight'
import { useGenerationPolling, parseRecordText, parseRecordUrl, parseRecordUrls, parseRecordLastFrameUrl, type GenerationPollTask } from '@/composables/useGenerationPolling'
import { buildNodeMediaInfoSummary, useMediaInspector } from '@/composables/useMediaInspector'
import { useGenerationFailureToast, shouldToastForFailure } from '@/composables/useGenerationFailureToast'
import type { GenerationRecord } from '@/services/studio-api'
import {
  modalityForNodeType,
  modelFieldForModality,
  useNodeGeneration,
} from '@/composables/useNodeGeneration'
import { useSelectionGenerate } from '@/composables/useSelectionGenerate'
import { isFeatureOn } from '@/composables/useFeatureFlag'
import { type CompositionRunGroup } from '@/composables/compositionRunGroup'
import { studioApi } from '@/services/studio-api'
import { canvasApi } from '@/services/canvas-api'
import { resolveUpstreamContext } from '@/composables/useUpstreamNodeContext'
import { resolveNodeRefs, type LocalRefBinding, type NodeRef } from '@/composables/useNodeRefs'
import {
  MISSING_REFS_CONFIRM_MESSAGE,
  MISSING_REFS_CONFIRM_TITLE,
  latestUserSidebarImageCount,
  shouldConfirmDirectGenerateWithoutRefs,
} from '@/utils/missingRefsConfirm'
import { NODE_GENERATION_STATUS, isDockGenerateBusy, isNodeGenerating, isPendingConfirmNode } from '@/constants/dockStudio'
import { nodeHasUsableOutput, shouldApplyGenerationPoll } from '@/utils/generationPollGate'
import CanvasNodePrompt from '@/components/canvas/CanvasNodePrompt.vue'
import CanvasNodeImage from '@/components/canvas/CanvasNodeImage.vue'
import CanvasNodeVideo from '@/components/canvas/CanvasNodeVideo.vue'
import CanvasNodeText from '@/components/canvas/CanvasNodeText.vue'
import CanvasNodeAudio from '@/components/canvas/CanvasNodeAudio.vue'
import NodePanelDock from '@/components/canvas/NodePanelDock.vue'
import DockStudioToolbar from '@/components/canvas/DockStudioToolbar.vue'
import DockNoticeLayer from '@/components/notice/DockNoticeLayer.vue'
import CanvasFloatingChrome from '@/components/canvas/CanvasFloatingChrome.vue'
import CanvasAccountChrome from '@/components/canvas/CanvasAccountChrome.vue'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'
import RefineCanvasBack from '@/components/canvas/RefineCanvasBack.vue'
import MembershipModal from '@/components/membership/MembershipModal.vue'
import type { MobileAppTab } from '@/components/mobile/MobileTabBar.vue'
import MobileCanvasShell from '@/components/mobile/MobileCanvasShell.vue'
import type { MobileShellAgentActions, MobileShellBatchActions } from '@/components/mobile/MobileCanvasShell.vue'
import CanvasBottomLeftControls from '@/components/canvas/CanvasBottomLeftControls.vue'
import MobileCanvasTopControls from '@/components/canvas/MobileCanvasTopControls.vue'
import ProviderConfigDialog from '@/components/canvas/ProviderConfigDialog.vue'
import ByokFallbackConfirmDialog from '@/components/canvas/ByokFallbackConfirmDialog.vue'
import { useProviderBootstrap } from '@/composables/useProviderBootstrap'
import { BYOK_FALLBACK_CONFIRM_MESSAGE, imageEditModelLabel, resolveImageEditModelKey } from '@lnkpi/shared'
import { CX_IMAGE_EDIT_ENABLED, canOpenRefineForNode, decideRefineDismiss } from '@/utils/refineSession'
import { decideAgentOpenWhileRefine } from '@/utils/refineChrome'
import { containFitSize } from '@/utils/centerExpand'
import type { RefineApplyPayload } from '@/components/canvas/refine/compareViewModel'
import { applyRefineAsChild } from '@/composables/useRefineApply'
import { shouldHideCanvasChrome } from '@/utils/canvasChromeVisibility'
import type { FallbackPendingRequest } from '@/composables/useNodeGeneration'
import { createFallbackConfirmQueue, fallbackConfirmKey } from '@/composables/fallbackConfirmQueue'
import type { StudioModality } from '@/constants/studioModels'
import ClickRippleLayer from '@/components/canvas/ClickRippleLayer.vue'
import CanvasRefPickOverlay from '@/components/canvas/CanvasRefPickOverlay.vue'
import ConnectNodePicker from '@/components/canvas/ConnectNodePicker.vue'
import ConnectPickerLine from '@/components/canvas/ConnectPickerLine.vue'
import { CONNECT_OUT_TARGET_TYPES } from '@/components/canvas/canvasDockMenu'
import { computeNewNodePosition, snapToGrid } from '@/composables/useCanvasNodePlacement'
import {
  applyArrangeLayout,
  applySnapOnRelease,
  createGroupFromSelection,
  detachNodesFromGroupNodes,
  foldGroups,
  getNodeSize,
  getSelectionBounds,
  isGroupNode,
  layoutNodesAlongEdges,
  layoutNodesInGrid,
  materializeGroups,
  patchGroupNodeData,
  releaseNodesFromGroups,
  resizeGroupByHandle,
  syncGroupsToFitChildren,
  ungroupById,
  type FlowNode,
  type GroupHandleDir,
} from '@/composables/useCanvasGrouping'
import { useModelProviderSettings } from '@/composables/useModelProviderSettings'
import MultiSelectToolbarOverlay from '@/components/canvas/MultiSelectToolbarOverlay.vue'
import ProposeConfirmOverlay from '@/components/canvas/ProposeConfirmOverlay.vue'
import CanvasNodeGroup from '@/components/canvas/CanvasNodeGroup.vue'
import SelectionBatchProgressCard from '@/components/canvas/SelectionBatchProgressCard.vue'
import MultiSelectConnectOverlay from '@/components/canvas/MultiSelectConnectOverlay.vue'
import BatchConnectPickerLine from '@/components/canvas/BatchConnectPickerLine.vue'
import EdgeScissorsOverlay from '@/components/canvas/EdgeScissorsOverlay.vue'
import { useCanvasViewportSettings, type CanvasViewportSettings } from '@/composables/useCanvasViewportSettings'
import { useCanvasTheme } from '@/composables/useCanvasTheme'
import { useCanvasKeyboard } from '@/composables/useCanvasKeyboard'
import {
  createCanvasUndoStack,
  patchTouchesGenerationFields,
  rememberGenerationFields,
  resolveGenerationFieldsForApply,
  stripGenerationFieldsFromData,
  type CanvasSnapshot,
  type GenerationFieldsCache,
} from '@/composables/useCanvasUndoStack'
import { detectFileKind, setupCanvasMediaHandlers, downloadMediaFile, mediaDownloadName, type MediaFilePayload } from '@/composables/useCanvasMedia'
import {
  exportWorkflowPackage,
  importWorkflowPackage,
  type WorkflowExportMode,
} from '@/composables/useWorkflowExchange'
import { fitImportedViewport } from '@/composables/fitImportedViewport'
import { fileToPersistedPayload, persistMediaUrl } from '@/composables/useMediaUpload'
import { useDebouncedNodePatch } from '@/composables/useDebouncedNodePatch'
import {
  CANVAS_MULTI_SELECT_ACTIVE_KEY,
  CANVAS_GROUP_RESIZE_KEY,
  CANVAS_NODE_ADD_AGENT_KEY,
  CANVAS_NODE_CANCEL_KEY,
  CANVAS_NODE_CLICK_GUARD_KEY,
  CANVAS_NODE_LOCATE_FLASH_KEY,
  CANVAS_NODE_OPEN_CONTEXT_MENU_KEY,
  CANVAS_NODE_PATCH_KEY,
  CANVAS_NODE_RENAME_KEY,
  CANVAS_NODE_RENAME_REQUEST_KEY,
  CANVAS_NODE_RETRY_KEY,
  CANVAS_AGENT_DIAGNOSE_KEY,
  CANVAS_REF_PICK_ACTIVE_KEY,
  CANVAS_REF_PICK_NODE_IDS_KEY,
  CANVAS_REF_PICK_REJECT_KEY,
  type CanvasGroupResizeFn,
  type CanvasNodeRetryOverrides,
} from '@/composables/canvasNodeActions'
import { useCanvasRefPickMode } from '@/composables/useCanvasRefPickMode'
import { useAgentMobileLayout } from '@/composables/useAgentMobileLayout'
import { useViewportGestures } from '@/composables/useViewportGestures'
import type { CanvasAssetItem } from '@/components/canvas/CanvasAssetPanel.vue'
import RefineWorkbench from '@/components/canvas/refine/RefineWorkbench.vue'
import MediaPreviewOverlay from '@/components/canvas/MediaPreviewOverlay.vue'
import MediaInspectorDrawer from '@/components/media/MediaInspectorDrawer.vue'
import CanvasContextMenu from '@/components/canvas/CanvasContextMenu.vue'
import { resolveNeoNodeTitle } from '@/components/canvas/neoNodeMeta'
import NodeCropOverlay from '@/components/canvas/NodeCropOverlay.vue'
import NodeOutpaintOverlay from '@/components/canvas/NodeOutpaintOverlay.vue'
import NodeInpaintOverlay from '@/components/canvas/NodeInpaintOverlay.vue'
import NodeElementEditOverlay from '@/components/canvas/NodeElementEditOverlay.vue'
import AnnotateOverlay from '@/components/canvas/AnnotateOverlay.vue'
import { drawAnnotates, type AnnotateShape } from '@/components/canvas/annotateModel'
import { combineElementEditPrompt, paintElementEditMask, preloadElementMaskImages, type ElementEditItem } from '@/components/canvas/elementEditModel'
import { displayRectToPixelRect } from '@/components/canvas/nodeCropModel'
import { loadCropSourceImage, renderCropBlob } from '@/components/canvas/refine/cropExport'
import { exportMaskPng } from '@/components/canvas/refine/maskExport'
import { computeOutpaintLayers } from '@/components/canvas/refine/outpaintComposite'
import {
  hasOutpaintExtension,
  type OutpaintRect,
} from '@/components/canvas/refine/outpaintGeometry'
import { renderOutpaintPngs } from '@/components/canvas/refine/outpaintRender'
import { OUTPAINT_FALLBACK_PROMPT } from '@/components/canvas/refine/outpaintFallback'
import GridSliceWorkbench from '@/components/canvas/grid-slice/GridSliceWorkbench.vue'
import { runGridSlice } from '@/composables/useGridSlice'
import { clampGridDims, GRID_SLICE_LAYOUT_GAP, layoutSliceChildPositions } from '@/utils/gridSlice'
import { saveAssetToLibrary } from '@/composables/useAssetLibrary'
import { resolveMediaUrl } from '@/services/api-base'
import { apiErrorMessage } from '@/utils/apiError'
import {
  duplicateSubgraph,
  resolveDuplicateSourceIds,
  type DuplicateEdgeMode,
} from '@/utils/duplicateCanvasSubgraph'
import PublishNeoTVDialog from '@/components/works/PublishNeoTVDialog.vue'
import AgentSideRail from '@/components/agent/AgentSideRail.vue'
import AgentNodeGraph from '@/components/agent/presentation/AgentNodeGraph.vue'
import { useAgentStore } from '@/stores/agent'
import { forcePendingConfirmInPayload, shouldSyncProposePending } from '@/components/agent/proposeWaitActions'
import { dedupeNodesById, mergeCanvasNodesFromServer } from '@/pages/canvas/canvasNodeMerge'
import { useSelectedNodeEditor, type EditableFlowNode, EDITABLE_NODE_TYPES } from '@/composables/useSelectedNodeEditor'
import type { CanvasEdgeLike } from '@/composables/useUpstreamNodeContext'
import { buildPollingFailurePatch } from '@/utils/generationDiagnostic'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const canvasEditor = useCanvasEditorStore()
const { registerLocateNodeHandler, closeInspector, openInspector } = useMediaInspector()
const sessionId = computed(() => route.params.sessionId as string)

interface CanvasEdge {
  id: string
  source: string
  target: string
  animated?: boolean
  style?: Record<string, string | number>
  sourceHandle?: string
  targetHandle?: string
}

const nodes = ref<EditableFlowNode[]>([])
const edges = ref<CanvasEdge[]>([])
const compositionRunGroup = ref<CompositionRunGroup | null>(null)
const lastKnownCompositionRunGroup = ref<CompositionRunGroup | null>(null)

/** 受控模式：:nodes + apply-default=false，由 onNodesChange 落地变更，避免内部/外部状态互相覆盖 */
const flowNodes = computed(() => nodes.value as unknown as Node[])

/** 选中单个节点时，回溯其全部上游连线（电流高亮，便于追踪数据来源） */
const upstreamEdgeIds = computed(() => {
  const ids = new Set<string>()
  const target = multiSelectedIds.value.length === 1 ? multiSelectedIds.value[0] : null
  if (!target) return ids
  const visited = new Set<string>([target])
  const queue = [target]
  while (queue.length) {
    const nodeId = queue.pop()!
    for (const edge of edges.value) {
      if (edge.target !== nodeId || ids.has(edge.id)) continue
      ids.add(edge.id)
      if (!visited.has(edge.source)) {
        visited.add(edge.source)
        queue.push(edge.source)
      }
    }
  }
  return ids
})

/** 选中单个节点时，顺流其全部下游连线（暖橙高亮，与上游电流青区分） */
const downstreamEdgeIds = computed(() => {
  const ids = new Set<string>()
  const source = multiSelectedIds.value.length === 1 ? multiSelectedIds.value[0] : null
  if (!source) return ids
  const visited = new Set<string>([source])
  const queue = [source]
  while (queue.length) {
    const nodeId = queue.pop()!
    for (const edge of edges.value) {
      if (edge.source !== nodeId || ids.has(edge.id)) continue
      ids.add(edge.id)
      if (!visited.has(edge.target)) {
        visited.add(edge.target)
        queue.push(edge.target)
      }
    }
  }
  return ids
})

const flowEdges = computed(() =>
  annotateEdgesForSelection(
    edges.value,
    upstreamEdgeIds.value,
    downstreamEdgeIds.value,
  ) as unknown as Edge[],
)

const {
  selectNode,
  clearEditorSelection,
  clearSelection,
  patchNodeData: patchNodeDataBase,
  selectedNodeId,
  selectedNode,
} = useSelectedNodeEditor(nodes)
const sessionTitle = ref('未命名画布')
const sessionOwnerId = ref<string | null>(null)
const agentReadOnly = computed(
  () => !!auth.user?.id && !!sessionOwnerId.value && auth.user.id !== sessionOwnerId.value,
)
const saving = ref(false)
/** 2026-10-21 用户裁决：保存状态行改「静默成功，只报异常」——成功态零渲染，
 *  仅失败点亮红胶囊（点按重试）。自动保存成功不再打时间戳（无消费方）。 */
const saveFailed = ref(false)
const showPublish = ref(false)
const showModelSettings = ref(false)
const contextMenu = ref<{
  x: number
  y: number
  nodeId?: string
  nodeType?: string
  nodeTitle?: string
  hasUrl?: boolean
  mediaKind?: string
  mimeType?: string
} | null>(null)
const { settings: viewportSettings, cycleMinimap } = useCanvasViewportSettings()
const { theme: canvasTheme } = useCanvasTheme()
const showMembership = ref(false)

/** Session cache so delete→undo can restore url/status/images/materialId after strip. */
const generationFieldsCache: GenerationFieldsCache = new Map()

/**
 * Generation/upload outcomes often patch + saveCanvas without commitAfterChange.
 * Remember those fields so delete→undo can restore url/status even when the
 * delete commit snapshot no longer contains the node.
 */
function patchNodeData(id: string, patch: Record<string, unknown>) {
  const touchesGen = patchTouchesGenerationFields(patch)
  patchNodeDataBase(id, patch)
  if (!touchesGen) return
  const node = nodes.value.find((n) => n.id === id)
  rememberGenerationFields(
    generationFieldsCache,
    id,
    node?.data as Record<string, unknown> | undefined,
  )
}

/** Belt-and-suspenders: capture gen fields before nodes leave the graph. */
function rememberGenerationFieldsBeforeRemove(ids: Iterable<string>) {
  const toRemember = new Set(ids)
  for (const n of nodes.value) {
    if (!toRemember.has(n.id)) continue
    rememberGenerationFields(
      generationFieldsCache,
      n.id,
      n.data as Record<string, unknown> | undefined,
    )
  }
}

function getCanvasHistorySnapshot(): CanvasSnapshot {
  return {
    nodes: nodes.value.map((n) => {
      const data = n.data as Record<string, unknown> | undefined
      rememberGenerationFields(generationFieldsCache, n.id, data)
      return {
        id: n.id,
        type: n.type,
        position: { x: n.position.x, y: n.position.y },
        parentNode: n.parentNode,
        extent: n.extent,
        expandParent: n.expandParent,
        data: stripGenerationFieldsFromData(data),
      }
    }),
    edges: edges.value.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
    })),
  }
}

function applyCanvasHistorySnapshot(snapshot: CanvasSnapshot) {
  const liveById = new Map(nodes.value.map((n) => [n.id, n]))
  // 2026-10-01 修：历史快照可能录自重放前的含重复状态，恢复时同样按 id 收敛。
  nodes.value = dedupeNodesById(snapshot.nodes).map((n) => {
    const live = liveById.get(n.id)
    const gen = resolveGenerationFieldsForApply(
      generationFieldsCache,
      n.id,
      live?.data as Record<string, unknown> | undefined,
    )
    return {
      ...n,
      data: {
        ...(n.data ?? {}),
        ...gen,
      },
    }
  })
  const animated = viewportSettings.value.edgeAnimated
  const ids = new Set(nodes.value.map((n) => n.id))
  edges.value = snapshot.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      animated,
    }))
}

const canvasUndo = createCanvasUndoStack({
  maxDepth: 50,
  getSnapshot: getCanvasHistorySnapshot,
  applySnapshot: applyCanvasHistorySnapshot,
})

/** User graph/param edit: commit undo checkpoint then persist. Skip for generation/poll/upload. */
function persistUserEdit() {
  canvasUndo.commitAfterChange()
  void saveCanvas()
}

async function persistUserEditAsync() {
  canvasUndo.commitAfterChange()
  await saveCanvas()
}

const DEFAULT_DARK_GRID_COLOR = 'rgb(var(--lnk-overlay-rgb) / 0.08)'
const effectiveGridColor = computed(() => {
  if (canvasTheme.value === 'light' && viewportSettings.value.gridColor === DEFAULT_DARK_GRID_COLOR) {
    return 'rgba(0,0,0,0.12)'
  }
  return viewportSettings.value.gridColor
})
const multiSelectedIds = ref<string[]>([])
/** 独占选中进行中：挡住 Vue Flow 随后的 select change 把源节点再次标成 selected */
let pendingExclusiveSelectId: string | null = null
let nodeCounter = 0

const pendingConnect = ref<{
  nodeId: string
  handleType: 'source' | 'target'
  handleId: string | null
} | null>(null)
let connectCompleted = false

const connectPicker = ref<{
  sourceNodeId: string
  sourceHandleId: string | null
  x: number
  y: number
} | null>(null)

const blankNodePicker = ref<{ x: number; y: number } | null>(null)
const selectedEdgeId = ref<string | null>(null)
const selectedEdgePos = ref({ x: 0, y: 0 })
const batchConnectPicker = ref<{ sourceIds: string[]; x: number; y: number } | null>(null)
const workflowImportInputRef = ref<HTMLInputElement | null>(null)

const { getConfig: getProviderConfig } = useModelProviderSettings()

/**
 * 快捷编辑链路（元素编辑 / 重绘 / 扩图）的生成模型：跟随画布 dock 选中的图像模型——
 * BYOK 渠道优先（用户插了自己的 key 就不该烧平台积分），平台/未配置回落 image2。
 * 与精修链路共用 shared 的 resolveImageEditModelKey，勿在组件里重写判定。
 */
const editModelKey = computed(() => resolveImageEditModelKey(getProviderConfig('image').model))

/** 快捷浮层上展示的生效模型名（避免「我选了 BYOK、实际烧平台」的错觉）。 */
const editModelLabel = computed(() => imageEditModelLabel(editModelKey.value))

const { preferences, load: loadProviderBootstrap } = useProviderBootstrap()

const fallbackDialog = ref<{
  open: boolean
  message: string
  loading: boolean
}>({ open: false, message: BYOK_FALLBACK_CONFIRM_MESSAGE, loading: false })

const fallbackConfirmQueue = createFallbackConfirmQueue({
  defaultMessage: BYOK_FALLBACK_CONFIRM_MESSAGE,
  onOpen: (message) => {
    fallbackDialog.value = { open: true, message, loading: false }
  },
  onClose: () => {
    fallbackDialog.value = { ...fallbackDialog.value, open: false, loading: false }
  },
})

function requestFallbackConfirm(req: FallbackPendingRequest) {
  return fallbackConfirmQueue.request(req)
}

function onFallbackDialogConfirm() {
  fallbackDialog.value = { ...fallbackDialog.value, loading: true }
  fallbackConfirmQueue.settle('confirm')
}

function onFallbackDialogCancel() {
  fallbackConfirmQueue.settle('cancel')
}

function isModelSelectable(modality: StudioModality, model: string): boolean {
  const prefs = preferences.value
  if (!prefs) return true
  const list =
    modality === 'image'
      ? prefs.selectableImageModels
      : modality === 'video'
        ? prefs.selectableVideoModels
        : modality === 'audio'
          ? prefs.selectableAudioModels
          : prefs.selectableTextModels
  return list.includes(model)
}

const minimapNodeList = computed(() => {
  const out: Array<{ id: string; type?: string; data: Record<string, unknown> }> = []
  for (const n of nodes.value) {
    out.push({ id: n.id, type: n.type, data: n.data as Record<string, unknown> })
  }
  return out
})

function patchViewportSettings(patch: Partial<CanvasViewportSettings>) {
  Object.assign(viewportSettings.value, patch)
}

function addEdge(partial: Pick<CanvasEdge, 'id' | 'source' | 'target'> & Partial<CanvasEdge>) {
  // 连线颜色统一由全局 CSS token（--neo-edge 系列）控制，不再写死 inline stroke
  edges.value.push({
    animated: viewportSettings.value.edgeAnimated,
    ...partial,
  })
}

watch(
  () => viewportSettings.value.edgeAnimated,
  (animated) => {
    edges.value = edges.value.map((edge) => ({ ...edge, animated }))
  },
)

// 2026-10-19：3D worldModel 与 PlayCanvas 评估模式下线，画布只剩 vueflow 一种。
const canvasInteractionEnabled = computed(() => !viewportSettings.value.viewLocked)

const canvasEdgeStyle = computed(() => {
  const s = viewportSettings.value
  const vars: Record<string, string> = {
    '--canvas-edge-width': `${s.edgeWidth}px`,
  }
  if (s.edgeColor.trim()) vars['--canvas-edge-color'] = s.edgeColor.trim()
  vars['--canvas-edge-glow'] = s.edgeGlow
    ? 'drop-shadow(0 0 5px color-mix(in srgb, var(--canvas-edge-color, var(--neo-edge)) 55%, transparent))'
    : 'none'
  vars['--canvas-edge-dash'] = s.edgeDash === 'dashed' && !s.edgeAnimated ? '6 8' : 'none'
  return vars
})

let onFallbackPendingFromPoll:
  | ((kind: 'studio' | 'material', id: string, nodeId: string, message?: string) => Promise<void>)
  | null = null

const fallbackPollClaimedKeys = new Set<string>()

async function invokeFallbackPendingFromPoll(
  kind: 'studio' | 'material',
  id: string,
  nodeId: string,
  message?: string,
) {
  const key = fallbackConfirmKey({ kind, id })
  // Claim synchronously so parallel poll ticks cannot both enter handlers
  // (shared Promise would otherwise double-call confirm/cancel APIs).
  if (fallbackPollClaimedKeys.has(key) || fallbackConfirmQueue.isPrompted(key)) return
  fallbackPollClaimedKeys.add(key)
  try {
    await onFallbackPendingFromPoll?.(kind, id, nodeId, message)
  } catch (err) {
    patchNodeData(nodeId, {
      status: NODE_GENERATION_STATUS.error,
      errorMessage: err instanceof Error ? err.message : '平台回退处理失败',
    })
    void saveCanvas()
  }
}

function parseFallbackMessage(metadata?: string | null): string | undefined {
  if (!metadata) return undefined
  try {
    const meta = JSON.parse(metadata) as { confirmMessage?: string }
    return typeof meta.confirmMessage === 'string' ? meta.confirmMessage : undefined
  } catch {
    return undefined
  }
}

const generationPolling = useGenerationPolling((results) => {
  for (const { task, record } of results) {
    const node = nodes.value.find((n) => n.id === task.nodeId)
    if (
      !shouldApplyGenerationPoll({
        nodeStatus: node?.data?.status,
        nodeRecordId: node?.data?.generationRecordId,
        incomingRecordId: record.id,
        incomingStatus: record.status,
      })
    ) {
      continue
    }
    if (record.status === NODE_GENERATION_STATUS.fallback_pending) {
      patchNodeData(task.nodeId, {
        status: NODE_GENERATION_STATUS.fallback_pending,
        generationRecordId: record.id,
      })
      void invokeFallbackPendingFromPoll(
        'studio',
        record.id,
        task.nodeId,
        parseFallbackMessage(record.metadata),
      )
      continue
    }
    if (record.status === NODE_GENERATION_STATUS.completed) {
      const urls = parseRecordUrls(record)
      const patch: Record<string, unknown> = {
        url: urls[0] ?? parseRecordUrl(record),
        status: NODE_GENERATION_STATUS.completed,
        errorMessage: null,
        generationRecordId: record.id,
      }
      if (record.type === 'text') {
        patch.content = parseRecordText(record)
      } else if (urls.length) {
        patch.images = urls
      }
      if (record.type === 'video') {
        const lastFrameUrl = parseRecordLastFrameUrl(record)
        if (lastFrameUrl) patch.lastFrameUrl = lastFrameUrl
      }
      const mediaSummary = buildNodeMediaInfoSummary(record)
      if (mediaSummary) patch.mediaInfo = mediaSummary
      patchNodeData(task.nodeId, patch)
    } else if (record.status === NODE_GENERATION_STATUS.failed || record.status === NODE_GENERATION_STATUS.error) {
      patchNodeData(
        task.nodeId,
        buildPollingFailurePatch({
          metadata: record.metadata,
          generationRecordId: record.id,
        }),
      )
    }
  }
  void saveCanvas()
  },
  {
    // 诊断 C3：单节点轮询墙钟到期（默认 22min，与批量路径一致）——节点置 error，
    // 不再永久「生成回复中」
    onTimeout: (task) => {
      // ⚠️ 2026-10-08 兜底守卫：墙钟只打击「真的什么也没拿到」的节点。
      // 此前无条件写 error，生产实测把已经 completed、产物图可正常访问的节点
      // 刷成 error（用户会以为生成失败并重复生成 ⇒ 重复扣分）。
      const node = nodes.value.find((n) => n.id === task.nodeId)
      if (nodeHasUsableOutput(node?.data)) return
      patchNodeData(task.nodeId, {
        status: NODE_GENERATION_STATUS.error,
        errorMessage: '等待生成结果超时，请重试或刷新查看任务历史',
      })
    },
  },
)

function startPollingForGeneratingRecords() {
  const tasks: GenerationPollTask[] = []
  for (const n of nodes.value) {
    if (
      n.type !== 'video' &&
      n.type !== 'image' &&
      n.type !== 'text' &&
      n.type !== 'audio'
    ) {
      continue
    }
    const data = n.data as Record<string, unknown>
    // Fix #1: accept any node with generationRecordId, regardless of status,
    // so terminal-state records (completed/failed) get fetched and re-applied
    // to nodes that lost recordId/url on loadSession().
    if (data.generationRecordId) {
      tasks.push({ recordId: String(data.generationRecordId), nodeId: n.id })
    }
  }
  if (tasks.length) generationPolling.start(tasks)
}

const editorNode = computed((): EditableFlowNode | null => {
  if (multiSelectedIds.value.length !== 1) return null
  // 多选模式（D-4）：S2/S3 互斥——多选态不弹单节点 dock
  if (mobileMultiSelectActive.value) return null
  const id = multiSelectedIds.value[0]
  for (const node of nodes.value) {
    if (node.id !== id) continue
    const type = String(node.type ?? '')
    if (!EDITABLE_NODE_TYPES.has(type)) return null
    return node as EditableFlowNode
  }
  return null
})

const gridSliceBusy = ref(false)
const gridSlicePanelNodeId = ref<string | null>(null)
/** 浮层一键抠图进行中（防重入 + matting 按钮 loading） */
const mattingBusy = ref(false)
/** 节点直裁：正在裁剪的节点 id（浮层「裁剪」进入，节点卡上覆盖裁剪层） */
const nodeCropNodeId = ref<string | null>(null)
/** 节点直裁导出/落盘进行中（确认按钮 loading + 防重入） */
const nodeCropBusy = ref(false)
/** 节点直出扩图：正在扩图的节点 id + 生成进行中 */
const nodeOutpaintNodeId = ref<string | null>(null)
const nodeOutpaintBusy = ref(false)
/** 节点直出局部重绘：正在重绘的节点 id + 生成进行中 */
const nodeInpaintNodeId = ref<string | null>(null)
const nodeInpaintBusy = ref(false)
/** 节点直出元素编辑：正在编辑的节点 id + 生成进行中（多选区局部编辑，复刻竞品） */
const nodeElementEditNodeId = ref<string | null>(null)
const nodeElementEditBusy = ref(false)

/**
 * 底部 dock 收缩（2026-09-25 用户拍板）：单击图片节点 dock 正常弹出（与快捷菜单并存）；
 * 用户点快捷菜单进入任一编辑浮层（裁剪/扩图/重绘/元素编辑）时 dock 自动收缩为底部热区
 * （悬停展开、划走收回），不再整块隐藏——保留提示词等原有能力。
 */
const dockCollapsedByOverlay = computed(
  () =>
    !!nodeCropNodeId.value ||
    !!nodeOutpaintNodeId.value ||
    !!nodeInpaintNodeId.value ||
    !!nodeElementEditNodeId.value ||
    !!nodeAnnotateNodeId.value,
)

const gridSlicePanelNode = computed((): EditableFlowNode | null => {
  if (!gridSlicePanelNodeId.value) return null
  const node = findNodeById(gridSlicePanelNodeId.value)
  return node ? (node as EditableFlowNode) : null
})

const refinePanelNode = computed((): EditableFlowNode | null => {
  if (!CX_IMAGE_EDIT_ENABLED) return null
  const target = canvasEditor.imageTarget
  if (!target) return null
  return findNodeById(target.nodeId)
})

/** 精修 / 宫格切分工作台打开时，画布级 chrome 全部让位（spec §7） */
const canvasChromeHidden = computed(() =>
  shouldHideCanvasChrome({
    refineOpen: !!refinePanelNode.value,
    gridSliceOpen: !!gridSlicePanelNode.value,
  }),
)

/**
 * ADR-0011 T1：画布上处于 pending_confirm 的节点 = 节点内联确认面（ProposeConfirmOverlay）锚点。
 *
 * 不依赖选中态——「节点即确认面」：确认 / 取消贴在节点上，用户无需先选中再找入口
 * （选中节点是「查看 / 编辑」语义，与「待确认」是两件事）。至多一个（propose 阻塞期
 * 一次只有一笔等待），find 取首个防御性兜底。与 selectionActionBarNode 天然互斥
 * （后者要求 url 非空，待确认节点还没有产物）。编辑浮层 / 精修 / 宫格工作台打开时让位。
 */
const proposeConfirmNode = computed((): EditableFlowNode | null => {
  if (refinePanelNode.value || gridSlicePanelNode.value) return null
  if (nodeCropNodeId.value || nodeOutpaintNodeId.value || nodeInpaintNodeId.value || nodeElementEditNodeId.value) {
    return null
  }
  const found = (nodes.value as EditableFlowNode[]).find((n) =>
    isPendingConfirmNode(n as { data?: { status?: unknown } | undefined }),
  )
  return found ?? null
})

/**
 * ADR-0011 T4：节点内联「编辑」按钮置位的**显式编辑意图**——覆盖 pending_confirm dock
 * 门控，让用户改提示词 / 参数后仍走同一确认路径（dock 生成按钮 → confirmProposeWait）。
 * 纯自动弹出仍被门控（决定 3）；节点离开待确认态（确认 / 取消 / 恢复）即失效。
 */
const proposeConfirmEditIntent = ref(false)

/** T4：选中节点待确认且无显式编辑意图 ⇒ studio dock 不自动弹（ADR-0011 决定 3）。 */
const dockGatedByPendingConfirm = computed(
  () => isPendingConfirmNode(editorNode.value) && !proposeConfirmEditIntent.value,
)

watch(proposeConfirmNode, (node) => {
  if (!node) proposeConfirmEditIntent.value = false
})

/** 编辑意图仅对「当前选中的待确认节点」有效：选中切离（选别的 / 点空白）即收回，
 *  避免用户逛一圈回来 dock 又自动弹（那会退化成 T4 要消灭的自动弹）。 */
watch(editorNode, (node) => {
  if (!node || node.id !== proposeConfirmNode.value?.id) proposeConfirmEditIntent.value = false
})

/** 单选 + 可操作图像节点时显示选中浮层（多选不出现；节点直裁/扩图/重绘进行中让位） */
const selectionActionBarNode = computed((): EditableFlowNode | null => {
  if (refinePanelNode.value || gridSlicePanelNode.value) return null
  if (nodeCropNodeId.value || nodeOutpaintNodeId.value || nodeInpaintNodeId.value || nodeElementEditNodeId.value) return null
  if (multiSelectedIds.value.length !== 1) return null
  // 多选模式（D-4）：S2/S3 互斥——多选态不出单选工具行
  if (mobileMultiSelectActive.value) return null
  const node = findNodeById(multiSelectedIds.value[0])
  if (!node) return null
  const data = (node.data ?? {}) as Record<string, unknown>
  if (!String(data.url ?? '').trim()) return null
  if (
    !canOpenRefineForNode({
      type: String(node.type ?? ''),
      mediaKind: typeof data.mediaKind === 'string' ? data.mediaKind : null,
      mimeType: typeof data.mimeType === 'string' ? data.mimeType : null,
    })
  ) {
    return null
  }
  return node as EditableFlowNode
})

/** 单选 image + 有 url；精修/宫格工作台打开时隐藏 */
const selectionGridSliceNode = computed((): EditableFlowNode | null => {
  if (refinePanelNode.value || gridSlicePanelNodeId.value) return null
  if (multiSelectedIds.value.length !== 1) return null
  const node = findNodeById(multiSelectedIds.value[0])
  if (!node || String(node.type ?? '') !== 'image') return null
  const data = (node.data ?? {}) as Record<string, unknown>
  if (!String(data.url ?? '').trim()) return null
  return node as EditableFlowNode
})

const gridSliceEntryDisabled = computed(() => {
  if (gridSliceBusy.value) return true
  const node = selectionGridSliceNode.value
  if (!node) return true
  const data = (node.data ?? {}) as Record<string, unknown>
  if (!String(data.url ?? '').trim()) return true
  return isNodeGenerating(data.status) || data.status === 'uploading'
})

/** 宫格切分原图尺寸（mediaInfo）：供 64px 单格下限禁用判定 */
const gridSliceImageSize = computed(() => {
  const info = selectionGridSliceNode.value?.data?.mediaInfo as
    | { kind?: string; width?: number; height?: number }
    | undefined
  if (!info || info.kind !== 'image') return null
  if (typeof info.width !== 'number' || typeof info.height !== 'number') return null
  return { width: info.width, height: info.height }
})

const gridSliceDisabledTitle = computed(() => {
  if (gridSliceBusy.value) return '切分中 · 大图约需数十秒'
  const node = selectionGridSliceNode.value
  if (!node) return '当前图片不可裁剪'
  const data = (node.data ?? {}) as Record<string, unknown>
  if (!String(data.url ?? '').trim()) return '图片尚未就绪'
  if (isNodeGenerating(data.status) || data.status === 'uploading') return '生成中，无法裁剪'
  return ''
})

const refineBeforeUrl = computed(() => {
  const data = refinePanelNode.value?.data as Record<string, unknown> | undefined
  return String(data?.url ?? canvasEditor.imageTarget?.url ?? '')
})

const refineGenerationRecordId = computed(() => {
  const id = refinePanelNode.value?.data?.generationRecordId
  return typeof id === 'string' ? id : undefined
})

const refineMediaWidth = computed(() => {
  const info = refinePanelNode.value?.data?.mediaInfo as { width?: number } | undefined
  return typeof info?.width === 'number' ? info.width : undefined
})

const refineMediaHeight = computed(() => {
  const info = refinePanelNode.value?.data?.mediaInfo as { height?: number } | undefined
  return typeof info?.height === 'number' ? info.height : undefined
})

const gridSliceUrl = computed(() => {
  const data = gridSlicePanelNode.value?.data as Record<string, unknown> | undefined
  return String(data?.url ?? '')
})

const gridSliceMediaWidth = computed(() => {
  const info = gridSlicePanelNode.value?.data?.mediaInfo as { width?: number } | undefined
  return typeof info?.width === 'number' ? info.width : undefined
})

const gridSliceMediaHeight = computed(() => {
  const info = gridSlicePanelNode.value?.data?.mediaInfo as { height?: number } | undefined
  return typeof info?.height === 'number' ? info.height : undefined
})

const editorUpstream = computed(() => {
  const node = editorNode.value
  if (!node) {
    return { textPrompt: '', referenceImageUrl: '', referenceImageNodeId: null, textNodeIds: [], lastFrameUrl: '', lastFrameVideoNodeId: null }
  }
  return resolveUpstreamContext(node.id, nodes.value, edges.value)
})

const selectedRefs = computed((): NodeRef[] => {
  const node = editorNode.value
  if (!node) return []
  return resolveNodeRefs({
    targetNodeId: node.id,
    targetType: String(node.type),
    nodes: nodes.value,
    edges: edges.value.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    localRefs: (node.data?.localRefs as LocalRefBinding[]) ?? [],
    refOrder: (node.data?.refOrder as string[]) ?? [],
  })
})

const mentionOptions = computed((): Array<{ id: string; label: string; type: string }> => {
  const refOptions = selectedRefs.value
    .filter((ref) => !ref.stale)
    .map((ref) => ({
      id: ref.refId,
      label: ref.refKey,
      type: ref.mediaType,
    }))
  if (refOptions.length) return refOptions

  const out: Array<{ id: string; label: string; type: string }> = []
  for (const n of nodes.value) {
    const data = n.data as Record<string, unknown>
    out.push({
      id: n.id,
      label: String(data.title ?? data.prompt ?? n.id),
      type: String(n.type ?? 'node'),
    })
  }
  return out
})

const multiSelectCanGenerateVideo = computed(() => {
  if (multiSelectedIds.value.length < 2) return false
  let hasText = false
  let hasImage = false
  for (const id of multiSelectedIds.value) {
    const node = findNodeById(id)
    if (!node) continue
    const type = String(node.type ?? '')
    if (type === 'text' || type === 'prompt') hasText = true
    if (type === 'image') {
      const url = String((node.data as Record<string, unknown>).url ?? '').trim()
      if (url) hasImage = true
    }
  }
  return hasText && hasImage
})

// ── 分组（2026-10-21 回归原生节点形态）──────────────────────────
//
// 分组在工作内存里是 `type:'group'` 的 vue-flow 节点（`nodeTypes.group`），
// 父子关系靠 parentNode + extent:'parent' + expandParent ⇒ 整框可拖、单击选中、
// 层级与命中测试全部由库提供，不再自研 overlay。
//
// **落库格式一行不改**：保存时 foldGroups() 把 group 节点折叠回
// `CanvasData.groups` + 子节点绝对坐标；加载时 materializeGroups() 反向物化。
// ⇒ `groups` 不再是第二份真值（消除了 #494 以来 nodes ⇄ groups 互相同步的漂移面），
// 也永远不会出现「group 节点被写进 canvasData.nodes」。
/** 当前选中的分组（点框即选中；工具条据此显示解组 + 色卡）。 */
const selectedGroupId = computed<string | null>(
  () => nodes.value.find((n) => n.selected && isGroupNode(n as unknown as FlowNode))?.id ?? null,
)

/** 单选一个分组时，工具条展示解组/色卡（复用旧 canUngroup 语义）。 */
const multiSelectCanUngroup = computed(() => Boolean(selectedGroupId.value))

/** 当前分组色（工具条色点高亮用；非分组 = null，落默认 neutral）。 */
const multiSelectGroupColorKey = computed(() => {
  const id = selectedGroupId.value
  if (!id) return null
  const key = nodes.value.find((n) => n.id === id)?.data?.colorKey
  return typeof key === 'string' ? key : null
})

/** 分组选中态优先（分组 id 也是节点 id，但工具条语义不同：解组 + 色卡）。 */
const toolbarSelectionIds = computed<string[]>(() =>
  selectedGroupId.value ? [selectedGroupId.value] : multiSelectedIds.value,
)

/** 打组后只留分组自身选中（清掉子节点多选，工具条才不会同时弹两套动作）。 */
function selectOnlyGroup(groupId: string) {
  nodes.value = nodes.value.map((n) => ({
    ...n,
    selected: n.id === groupId,
  }))
  multiSelectedIds.value = []
  clearSelection()
}

/** 框选多个节点 → 打组。每条路径都必须给反馈（静默 = 用户读成「打组失败」）。 */
function handleGroupSelection() {
  if (multiSelectedIds.value.length < 2) {
    ElMessage.info('请先框选至少 2 个节点再打组')
    return
  }
  const picked = multiSelectedIds.value.length
  const result = createGroupFromSelection(flowNodes.value, multiSelectedIds.value)
  if (!result) {
    ElMessage.info('请先框选至少 2 个节点再打组')
    return
  }
  nodes.value = result.nodes as EditableFlowNode[]
  selectOnlyGroup(result.groupId)
  persistUserEdit()
  // 分组框可能很大（子节点分散），明确告诉用户发生了什么、框里会有什么。
  const title = String(nodes.value.find((n) => n.id === result.groupId)?.data?.title ?? '未命名分组')
  if (result.mode === 'reselect') {
    ElMessage.info(`所选 ${picked} 个节点已在「${title}」中，已为你选中该分组`)
  } else if (result.mode === 'merged') {
    ElMessage.success(`已把所选 ${result.childIds.length} 个节点归并为「${title}」`)
  } else {
    ElMessage.success(`已打组「${title}」，含 ${result.childIds.length} 个节点`)
  }
}

/**
 * 解组：只移除分组框，子节点保持原坐标。
 * 框不存在时静默返回 —— 调用方（工具条 / 快捷键）不该因此报「解组失败」。
 */
function handleUngroupSelection(id?: string) {
  const targetId = id ?? selectedGroupId.value
  if (!targetId) return
  const next = ungroupById(flowNodes.value, targetId)
  if (!next) return
  nodes.value = next as EditableFlowNode[]
  multiSelectedIds.value = []
  clearSelection()
  persistUserEdit()
}

/** 分组背景色（null = 复位默认中性）。 */
function handleGroupColorSelection(key: string | null) {
  const id = selectedGroupId.value
  if (!id) return
  nodes.value = patchGroupNodeData(flowNodes.value, id, { colorKey: key }) as EditableFlowNode[]
  persistUserEdit()
}

/**
 * 节点被删后收拾分组：把被删节点放出来，剩余不足 2 个的分组自动解散。
 * 注意顺序：**先删节点再收拾分组**，否则绝对坐标会算在已经不存在的节点上。
 */
function forgetGroupsForRemovedNodes(removedIds: Iterable<string>) {
  nodes.value = detachNodesFromGroupNodes(flowNodes.value, removedIds) as EditableFlowNode[]
}

/** 子节点位置/尺寸变化后把分组框贴回包围盒（拖拽结束、加载完成都调；幂等）。 */
function fitGroups() {
  nodes.value = syncGroupsToFitChildren(flowNodes.value) as EditableFlowNode[]
}

/**
 * 分组选中态是从 `node.selected` 派生的（不是独立 ref），所以「退出分组选中」
 * = 把分组节点的 selected 打掉。没有分组被选中时零扰动（不改 nodes 引用）。
 */
function clearGroupSelection() {
  const hasSelectedGroup = nodes.value.some(
    (n) => n.selected && isGroupNode(n as unknown as FlowNode),
  )
  if (!hasSelectedGroup) return
  nodes.value = nodes.value.map((n) =>
    n.selected && isGroupNode(n as unknown as FlowNode) ? { ...n, selected: false } : n,
  )
}

/**
 * 与画布现状对齐：父分组已不存在的子节点回顶层（自愈 agent 删节点 / 存量脏数据），
 * 再把每个分组框贴回子节点包围盒。幂等。
 */
function reconcileGroups() {
  const present = new Set(nodes.value.map((n) => n.id))
  const orphans = nodes.value
    .filter((n) => n.parentNode && !present.has(n.parentNode))
    .map((n) => n.id)
  if (orphans.length > 0) {
    nodes.value = releaseNodesFromGroups(flowNodes.value, orphans) as EditableFlowNode[]
  }
  fitGroups()
}

/**
 * 移动端不拖分组框（GC4）：整块框在触屏上会吃掉平移/长按手势。
 * PC 端整框可拖是本批的核心诉求，所以这里按布局而不是按能力关。
 * 无分组节点 / 已经是目标值时零扰动（不改 nodes 引用）。
 */
function applyGroupDraggable(mobile: boolean) {
  const wants = !mobile
  const groups = nodes.value.filter((n) => isGroupNode(n as unknown as FlowNode))
  if (groups.length === 0 || groups.every((n) => n.draggable === wants)) return
  nodes.value = nodes.value.map((n) =>
    isGroupNode(n as unknown as FlowNode) ? { ...n, draggable: wants } : n,
  )
}


// 派生：plan（懒计算，仅当选区 ≥ 2 时）
// meta 同时承载 regenerate 版 plan 与整批阻断态（pending_confirm / 24 上限），
// 供工具栏显示「重新生成 · M」「待确认 · N」「超上限 · N」。
interface MultiSelectBatchMeta {
  plan: PlanSelectionGenerateResult | null
  regenPlan: PlanSelectionGenerateResult | null
  blocked: 'pending_confirm' | 'limit_24' | 'missing_prompt' | null
  blockedCount: number
  /** 缺提示词（无可尝试输入）节点数 */
  missingCount: number
}

/** 节点是否有可尝试的生成输入：本地提示词/内容，或上游可用输出可作参考（与 generateForNode 的静默跳过条件对齐）。 */
function nodeHasAttemptableInput(id: string): boolean {
  const node = findNodeById(id)
  if (!node) return false
  const d = (node.data ?? {}) as Record<string, unknown>
  if (String(d.prompt ?? d.content ?? '').trim()) return true
  const upstreamIds = edges.value.filter(e => e.target === id).map(e => e.source)
  return upstreamIds.some(uid => {
    const u = findNodeById(uid)
    if (!u) return false
    const status = (u.data as Record<string, unknown>).status
    if (status !== NODE_GENERATION_STATUS.completed) return false
    const type = String(u.type)
    if (type === 'image' || type === 'video') {
      const url = String((u.data as Record<string, unknown>).url ?? '').trim()
      const images = (u.data as Record<string, unknown>).images
      return Boolean(url) || (Array.isArray(images) && images.some((item) => String(item ?? '').trim()))
    }
    if (type === 'text' || type === 'prompt') {
      return Boolean(String((u.data as Record<string, unknown>).content ?? (u.data as Record<string, unknown>).prompt ?? '').trim())
    }
    return true
  })
}

const multiSelectBatchMeta = computed<MultiSelectBatchMeta | null>(() => {
  if (!isFeatureOn('selection_batch_generate')) return null
  if (multiSelectedIds.value.length < 2) return null
  const build = (regenerate: boolean) => planSelectionGenerate({
    selectedIds: multiSelectedIds.value,
    canvas: {
      nodes: nodes.value.map(n => ({ id: n.id, type: String(n.type ?? ''), data: n.data as Record<string, unknown> })),
      edges: edges.value as Array<{ id: string; source: string; target: string }>,
    },
    hasUsableOutput: (n) => {
      const full = nodes.value.find(x => x.id === n.id)
      if (!full) return false
      const status = (full.data as Record<string, unknown>).status
      if (status !== NODE_GENERATION_STATUS.completed) return false
      const type = String(full.type)
      if (type === 'image' || type === 'video') {
        const url = String((full.data as Record<string, unknown>).url ?? '').trim()
        const images = (full.data as Record<string, unknown>).images
        return Boolean(url) || (Array.isArray(images) && images.some((item) => String(item ?? '').trim()))
      }
      if (type === 'text' || type === 'prompt') {
        return Boolean(String((full.data as Record<string, unknown>).content ?? (full.data as Record<string, unknown>).prompt ?? '').trim())
      }
      return true
    },
    isInFlight: (id) => isNodeBusy(id),
    hasAttemptableInput: (n) => nodeHasAttemptableInput(n.id),
    regenerate,
  })
  try {
    const plan = build(false)
    const regenPlan = build(true)
    const missingCount = plan.skip.filter(s => s.reason === 'missing_prompt').length
    return { plan, regenPlan, blocked: null, blockedCount: 0, missingCount }
  } catch (e) {
    if (e instanceof SelectionBatchLimitError) {
      return { plan: null, regenPlan: null, blocked: 'limit_24', blockedCount: e.actualCount, missingCount: 0 }
    }
    if (e instanceof SelectionBatchPendingConfirmError) {
      return { plan: null, regenPlan: null, blocked: 'pending_confirm', blockedCount: countPendingInSelection(), missingCount: 0 }
    }
    throw e
  }
})

/** 选区内 pending_confirm 节点计数，用于阻断态提示。 */
function countPendingInSelection(): number {
  let count = 0
  for (const id of multiSelectedIds.value) {
    const node = findNodeById(id)
    if (!node) continue
    if (String((node.data as Record<string, unknown> | undefined)?.status ?? '') === 'pending_confirm') count++
  }
  return count
}

const multiSelectPlan = computed<PlanSelectionGenerateResult | null>(() => multiSelectBatchMeta.value?.plan ?? null)

// 选择 batch API
const selectionBatchApi = useSelectionGenerate({
  nodes: nodes as Ref<EditableFlowNode[]>,
  edges: edges as Ref<CanvasEdgeLike[]>,
  generateForNode: (node) => (generateForNode as any)(node, { asRunGroupMember: true }),
  // 等待节点真正 settle（completed/error）再计数，修复"任务未完成就弹完成汇总"
  waitForNodeSettled: (id) => waitForRunGroupMemberSettled(id),
  hasUsableOutput: (n) => {
    const status = (n.data as Record<string, unknown>).status
    if (status !== NODE_GENERATION_STATUS.completed) return false
    const type = String(n.type)
    if (type === 'image' || type === 'video') {
      const url = String((n.data as Record<string, unknown>).url ?? '').trim()
      const images = (n.data as Record<string, unknown>).images
      return Boolean(url) || (Array.isArray(images) && images.some((item) => String(item ?? '').trim()))
    }
    if (type === 'text' || type === 'prompt') {
      return Boolean(String((n.data as Record<string, unknown>).content ?? (n.data as Record<string, unknown>).prompt ?? '').trim())
    }
    return true
  },
  resolveUpstreamIds: (n) => {
    // 简化：仅从 edges 推上游
    return edges.value.filter(e => e.target === n.id).map(e => e.source)
  },
  cancelGeneration: (id) => cancelGeneration(id),
  isInFlight: (id) => isNodeBusy(id),
  toast: (msg, kind) => {
    if (kind === 'error') ElMessage.error(msg)
    else if (kind === 'warn') ElMessage.warning(msg)
    else ElMessage.info(msg)
  },
})

// 给工具栏的 selectionBatch prop
const selectionBatchProp = computed(() => {
  if (!isFeatureOn('selection_batch_generate')) return undefined
  const meta = multiSelectBatchMeta.value
  if (!meta) return undefined
  return {
    runCount: meta.plan?.run.length ?? 0,
    regenCount: meta.regenPlan?.run.length ?? 0,
    state: selectionBatchApi.state.value,
    blocked: meta.blocked ?? undefined,
    blockedCount: meta.blockedCount || undefined,
    missingCount: meta.missingCount || undefined,
  }
})

// 最近一次批量是否为重新生成（进度卡标题区分用）
const lastBatchRegenerate = ref(false)

/** 计划中缺提示词节点数 → 点名提示（这些节点不会执行） */
function warnMissingPrompt(plan: PlanSelectionGenerateResult) {
  const missing = plan.skip.filter(s => s.reason === 'missing_prompt').length
  if (missing > 0) {
    ElMessage.warning(`${missing} 个节点未写提示词且无可用上游输出，未执行`)
  }
}

// 处理点击
async function handleSelectionBatchGenerate() {
  const plan = multiSelectPlan.value
  if (!plan || plan.run.length === 0) return
  lastBatchRegenerate.value = false
  warnMissingPrompt(plan)
  try {
    await selectionBatchApi.start(plan)
  } catch {
    // start() 内部已 toast 并把状态回落 idle，这里只吞掉 rejection，避免 unhandled rejection
    return
  }
  // 收尾 toast
  const p = selectionBatchApi.progress.value
  ElMessage.info(
    `完成 ${p.done}，失败 ${p.failed}，取消 ${p.cancelled}，超时 ${p.timeout}，跳过 ${p.skipped}`,
  )
}

/** 批量重新生成：确认弹窗（覆盖产物 + 积分提示）→ 与普通批量共用同一执行器。 */
async function handleSelectionBatchRegenerate() {
  const meta = multiSelectBatchMeta.value
  const plan = meta?.regenPlan
  if (!plan || plan.run.length === 0) return
  lastBatchRegenerate.value = true
  warnMissingPrompt(plan)
  try {
    await ElMessageBox.confirm(
      `将重新生成 ${plan.run.length} 个节点，覆盖现有产物（不可撤销），并可能消耗积分。`,
      '批量重新生成',
      { confirmButtonText: '重新生成', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    await selectionBatchApi.start(plan, { regenerate: true })
  } catch {
    return
  }
  const p = selectionBatchApi.progress.value
  ElMessage.info(
    `完成 ${p.done}，失败 ${p.failed}，取消 ${p.cancelled}，超时 ${p.timeout}，跳过 ${p.skipped}`,
  )
}

/** 阻断态点击：pending_confirm → 定位待确认节点；超上限 → toast；缺提示词 → 定位第一个问题节点。 */
function handleSelectionBatchBlocked(reason: 'pending_confirm' | 'limit_24' | 'missing_prompt') {
  if (reason === 'pending_confirm') {
    ElMessage.info('选区包含待确认节点，已定位；请在节点上确认生成')
    const pendingId = multiSelectedIds.value
      .map(findNodeById)
      .find(n => n && String((n.data as Record<string, unknown> | undefined)?.status ?? '') === 'pending_confirm')
    if (pendingId) selectOnlyNode(pendingId.id)
    return
  }
  if (reason === 'missing_prompt') {
    ElMessage.warning('选区节点均未写提示词且无可用上游输出，已定位第一个问题节点')
    const problemId = multiSelectedIds.value
      .find(id => !nodeHasAttemptableInput(id))
    if (problemId) selectOnlyNode(problemId)
    return
  }
  ElMessage.warning('选区可执行节点超过 24 个上限，请减少选区后重试')
}

function handleSelectionBatchStop() {
  selectionBatchApi.stop()
}

const nodeTypes = {
  // 🔴 2026-10-17 prompt 节点下线：渲染分支仅为存量兜底保留（无创建入口；Dock 已降级只读）。
  prompt: CanvasNodePrompt,
  image: CanvasNodeImage,
  video: CanvasNodeVideo,
  text: CanvasNodeText,
  audio: CanvasNodeAudio,
  // 2026-10-21 分组回归原生节点形态：整框可拖 / 单击选中由 vue-flow 提供。
  // ⛔ 它只在内存里存在，保存时会被 foldGroups 折叠回 canvasData.groups。
  group: CanvasNodeGroup,
}

function onConnect(connection: Connection) {
  connectCompleted = true
  pendingConnect.value = null
  connectPicker.value = null
  addEdge({
    id: `e-${connection.source}-${connection.target}`,
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle ?? undefined,
    targetHandle: connection.targetHandle ?? undefined,
  })
  persistUserEdit()
}

function onConnectStart(params: OnConnectStartParams & { event?: MouseEvent | TouchEvent }) {
  connectCompleted = false
  connectPicker.value = null
  if (!params.nodeId || !params.handleType) return
  pendingConnect.value = {
    nodeId: params.nodeId,
    handleType: params.handleType,
    handleId: params.handleId,
  }
}

function getConnectEndClientPoint(event: MouseEvent | TouchEvent) {
  if ('changedTouches' in event && event.changedTouches.length > 0) {
    return {
      x: event.changedTouches[0].clientX,
      y: event.changedTouches[0].clientY,
    }
  }
  const mouse = event as MouseEvent
  return { x: mouse.clientX, y: mouse.clientY }
}

function onConnectEnd(event?: MouseEvent | TouchEvent) {
  if (connectCompleted) {
    pendingConnect.value = null
    return
  }

  const pending = pendingConnect.value
  pendingConnect.value = null
  if (!pending || !event || pending.handleType !== 'source') return

  const { x: clientX, y: clientY } = getConnectEndClientPoint(event)
  const droppedOnNode = document.elementFromPoint(clientX, clientY)?.closest('.vue-flow__node')
  if (droppedOnNode) return

  window.setTimeout(() => {
    connectPicker.value = {
      sourceNodeId: pending.nodeId,
      sourceHandleId: pending.handleId,
      x: clientX,
      y: clientY,
    }
  }, 50)
}

function closeConnectPicker() {
  connectPicker.value = null
}

function screenToFlowPoint(x: number, y: number) {
  const flow = vueFlowRef.value as {
    screenToFlowCoordinate?: (pos: { x: number; y: number }) => { x: number; y: number }
  } | null
  if (!flow?.screenToFlowCoordinate) return { x: 280, y: 180 }
  return flow.screenToFlowCoordinate({ x, y })
}

function createNodeAt(type: DockNodeType, position: { x: number; y: number }) {
  const prefs = preferences.value
  const textModel = getProviderConfig('text').model
  const imageModel = getProviderConfig('image').model
  const videoModel = getProviderConfig('video').model
  const audioModel = getProviderConfig('audio').model
  const imageCount = 1
  const imageAspect = prefs?.defaultImageAspect || '16:9'
  const imageResolution = prefs?.defaultImageResolution || '1K'
  const videoSettings = {
    aspectRatio: prefs?.defaultVideoAspect || '16:9',
    duration: prefs?.defaultVideoDuration || 5,
    resolution: prefs?.defaultVideoResolution || '720p',
    crop: prefs?.defaultVideoCrop || 'none',
  }
  let id: string
  switch (type) {
    case 'text':
      id = addNode('text', { content: '', status: 'idle', textModel }, { position })
      break
    // 被删历史（2026-10-17 prompt 节点下线）：case 'prompt'
    // （addNode('prompt', { prompt: '', label: '提示词', status: 'idle', textModel })）
    // 曾在此；创建菜单项已同步移除。
    case 'image':
      id = addNode(
        'image',
        {
          url: '',
          status: 'idle',
          prompt: '',
          imageModel,
          imageAspect,
          imageResolution,
          imageCount,
        },
        { position },
      )
      break
    case 'video':
      id = addNode(
        'video',
        { url: '', status: 'idle', prompt: '', videoModel, videoSettings },
        { position },
      )
      break
    case 'audio':
      id = addNode(
        'audio',
        {
          url: '',
          status: 'idle',
          prompt: '',
          audioModel,
          audioVoice: prefs?.audioVoice || 'female-shaonv',
          audioFormat: prefs?.audioFormat || 'mp3',
          audioSpeed: prefs?.audioSpeed ?? 1,
          ...(prefs?.audioInstructions ? { audioInstructions: prefs.audioInstructions } : {}),
        },
        { position },
      )
      break
    default:
      return null
  }
  return id
}

function connectSourceToNode(sourceNodeId: string, targetNodeId: string) {
  const edgeId = `e-${sourceNodeId}-${targetNodeId}`
  if (edges.value.some((edge) => edge.id === edgeId)) return
  addEdge({ id: edgeId, source: sourceNodeId, target: targetNodeId })
}

function handleBlankPickerSelect(type: DockNodeType) {
  const picker = blankNodePicker.value
  if (!picker) return
  blankNodePicker.value = null

  const flowPoint = screenToFlowPoint(picker.x, picker.y)
  const { w, h } = getNodeSize({ type } as FlowNode)
  const grid = viewportSettings.value.gridGap
  const snap = viewportSettings.value.snapToGrid
  const position = {
    x: snap ? snapToGrid(flowPoint.x - w / 2, grid) : flowPoint.x - w / 2,
    y: snap ? snapToGrid(flowPoint.y - h / 2, grid) : flowPoint.y - h / 2,
  }

  const id = createNodeAt(type, position)
  if (!id) return
  selectOnlyNode(id)
  persistUserEdit()
  void focusNodeById(id)
}

function closeBlankNodePicker() {
  blankNodePicker.value = null
}

function handleConnectPickerSelect(type: DockNodeType) {
  const picker = connectPicker.value
  if (!picker) return
  connectPicker.value = null

  const flowPoint = screenToFlowPoint(picker.x, picker.y)
  const { w, h } = getNodeSize({ type } as FlowNode)
  const grid = viewportSettings.value.gridGap
  const snap = viewportSettings.value.snapToGrid
  const position = {
    x: snap ? snapToGrid(flowPoint.x - w / 2, grid) : flowPoint.x - w / 2,
    y: snap ? snapToGrid(flowPoint.y - h / 2, grid) : flowPoint.y - h / 2,
  }

  const id = createNodeAt(type, position)
  if (!id) return

  connectSourceToNode(picker.sourceNodeId, id)
  selectOnlyNode(id)
  persistUserEdit()
  void focusNodeById(id)
}

function addNode(
  type: string,
  data: Record<string, unknown> = {},
  opts?: { id?: string; position?: { x: number; y: number } },
) {
  nodeCounter++
  const id = opts?.id ?? `${type}-${nodeCounter}`
  nodes.value.push({
    id,
    type,
    position: opts?.position ?? { x: 200 + nodeCounter * 60, y: 150 + nodeCounter * 40 },
    data: { createdAt: Date.now(), ...data },
  })
  return id
}

// ── node_graph 动作（2026-07-24）──────────────────────────────────────────
// 三枚图标：展开到画布 / 导入到画布 / 在新窗口打开（后者在组件内做 blob 快照）。
// 数据源都是 AgentSideRail 的 `node_graph` 载荷（position 来自画布 SSOT，零翻译）。

/** 展开层的数据（null = 未展开）。 */
/**
 * 「全屏图视图」模式（2026-07-24 改版）：`/workflow/<sid>?graph=1` 时**整页**渲染节点图。
 *
 * ⭐ 为什么从「覆盖层」改成「独立路由 + query」：
 *   覆盖层有三个实测问题 —— 高度算不准（用户反馈"没拉满"）、半透明透底、
 *   抢滚轮；而且它**盖住主画布**，无法与主画布并存。
 *   改成独立路由后：浏览器保证全屏、不透明、滚轮归自己，
 *   并且能和主窗口**并排**（一个看图、一个继续在画布上工作）。
 *
 * ⚠️ 图数据来源：与 agent 卡片同源（executionEvents 里的 node_graph command），
 *   经`stores/agent` 的 `loadHistory` 复原 ⇒ 不需要额外取图接口。
 */
const graphOnly = computed(() => route.query.graph === '1')

/** 从会话事件里取**最近一张**节点图（与气泡卡片同一份数据）。 */
const sessionGraph = computed<import('@/components/agent/presentation/AgentNodeGraph.vue').GraphPayload | null>(() => {
  if (!graphOnly.value) return null
  const agent = useAgentStore()
  const msg = [...agent.messages]
    .reverse()
    .find(
      (m) =>
        m.role === 'assistant' &&
        m.presentation?.kind === 'node_graph' &&
        Array.isArray((m.presentation.body as { graph_nodes?: unknown } | undefined)?.graph_nodes),
    )
  if (!msg) return null
  const body = msg.presentation?.body as
    | { graph_nodes?: import('@/components/agent/presentation/AgentNodeGraph.vue').GraphNode[]
        graph_edges?: import('@/components/agent/presentation/AgentNodeGraph.vue').GraphEdge[]
        nodeGraphTitle?: string }
    | undefined
  return {
    nodes: body?.graph_nodes ?? [],
    edges: body?.graph_edges ?? [],
    title: body?.nodeGraphTitle ?? msg.presentation?.title,
  }
})

/**
 * 「导入到画布」：建成**结构化节点组**，不是一张位图。
 *
 * ⚠️ 为什么不用位图（2026-07-24 的产品决策）：
 *   位图在画布上只是一块像素 —— agent 之后无法理解它、不能基于它推理，
 *   且与画布上「真实资产」节点的语义冲突 ⇒ 会积累技术债。
 *   结构化节点组则**可编辑、可被 agent 读懂**，与画布自身模型一致。
 * ⚠️ 位置沿用图里的坐标（可能与现有节点重叠）⇒ 给一个固定偏移量，避免完全压在一起。
 */
function handleImportNodeGraph(payload: {
  nodes: import('@/components/agent/presentation/AgentNodeGraph.vue').GraphNode[]
  edges: import('@/components/agent/presentation/AgentNodeGraph.vue').GraphEdge[]
  title?: string
}) {
  const OFFSET = { x: 120, y: 120 }
  for (const raw of payload.nodes) {
    // 2026-10-19 节点下线：group 已退出节点类型联合，导入时回退为 text 占位。
    const nodeType = raw.type === 'group' ? 'text' : (raw.type ?? 'text')
    addNode(
      nodeType,
      { title: raw.title ?? raw.id, text: raw.title ?? raw.id, importedFrom: 'node_graph' },
      {
        position: {
          x: (raw.position?.x ?? 0) + OFFSET.x,
          y: (raw.position?.y ?? 0) + OFFSET.y,
        },
      },
    )
  }
  // 提示用仓库既有的 ElMessage（与上面 `toast` 同一套）
  ElMessage.success(`已导入到画布：${payload.nodes.length} 个节点`)
}

async function handleAgentActions(actions: unknown[]) {
  const result = applyActionsToFlow(
    nodes.value as unknown as import('@/composables/useCanvasActions').FlowNode[],
    edges.value as unknown as import('@/composables/useCanvasActions').FlowEdge[],
    actions as CanvasAction[],
  )
  nodes.value = result.nodes as unknown as EditableFlowNode[]
  edges.value = result.edges as unknown as CanvasEdge[]
  // 分组是节点：agent 可能删/移节点 ⇒ 对齐分组（孤儿回顶层、框贴回包围盒）。
  reconcileGroups()
  // set_viewport action：把模型指定的视口落到位（与 panViewport 同款的防御式取用）
  if (result.viewport) {
    const flow = vueFlowRef.value as {
      setViewport?: (
        viewport: { x: number; y: number; zoom: number },
        options?: { duration?: number },
      ) => void
    } | null
    flow?.setViewport?.(result.viewport, { duration: 300 })
  }
  // Fix #3: also start generation polling so any record-id-bearing nodes
  // (status:generating now) get polled to terminal state.
  startPollingForGeneratingRecords()
  // Hydrate run-group extras as soon as actions land (not only loadSession),
  // so persistUserEdit cannot PUT canvas without compositionRunGroup.
  await hydrateCompositionRunGroupFromSession()
  // 勿 persistUserEdit：Nest Agent tools 已写 Session.canvasData；
  // 用本地旧图 + 部分 action 回写会抹掉追加拆图节点。
}

// ⭐ 2026-10-18 修复：回合结束后只有 60s 有限对账轮询（handleAgentTurnComplete，
// 15×4s），而上游生成实测可 >8min（生产案例：t2i 16:55:40 发起、url 17:03:52 才落
// canvasData）⇒ url 到达时对账窗口已关，时间线产物行永远停在「待确认」。
// 改为长活监听：watch 节点「终态签名」（id+status+url+有无 content——只读生成相关
// 字段，拖拽/视口变化不触发），节流转交 rail 对账；SideRail.reconcileFromNodes
// 按 mapNodeStatus「有正据才动」口径幂等回填，重复触发无害。
// 附带修掉：刷新页面后历史回合的 pending 产物行（loadSession 首次写入签名即触发）。
let railReconcileTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRailReconcile() {
  if (railReconcileTimer !== null) return
  railReconcileTimer = setTimeout(() => {
    railReconcileTimer = null
    const snap = nodes.value.map((n) => ({
      id: n.id,
      type: n.type,
      data: (n.data || {}) as Record<string, unknown>,
    }))
    agentRailRef.value?.reconcileFromNodes?.(snap)
  }, 2500)
}
const railReconcileSignature = computed(() =>
  nodes.value
    .map((n) => {
      const d = (n.data || {}) as Record<string, unknown>
      return `${n.id}:${String(d.status ?? '')}:${typeof d.url === 'string' ? d.url : ''}:${d.content ? 1 : 0}`
    })
    .join('|'),
)
watch(railReconcileSignature, scheduleRailReconcile)

async function handleAgentTurnComplete() {
  // SP-A：回拉前快照本地节点 id，回拉后差集即「本回合新节点」
  const beforeIds = new Set(nodes.value.map((n) => n.id))
  await loadSession()
  await nextTick()
  const newNodeIds = nodes.value.filter((n) => !beforeIds.has(n.id)).map((n) => n.id)
  try {
    if (newNodeIds.length > 0) {
      // 有新节点：只把新区域带入视口，不劫持用户的全局缩放（SP-A 规格 §5.4）
      await vueFlowRef.value?.fitView({ nodes: newNodeIds, padding: 0.45, maxZoom: 1.05, duration: 360 })
    } else {
      await vueFlowRef.value?.fitView({ padding: 0.24, duration: 360 })
    }
  } catch {
    // ignore（含组件卸载竞态：vueFlowRef 已置空）
  }
  const snap = nodes.value.map((n) => ({
    id: n.id,
    type: n.type,
    data: (n.data || {}) as Record<string, unknown>,
  }))
  agentRailRef.value?.reconcileFromNodes?.(snap)

  // Poll a few times after SSE may have dropped (~120s) while Nest still finishes gens
  let polls = 0
  const maxPolls = 15
  const timer = window.setInterval(() => {
    void (async () => {
      polls += 1
      try {
        await loadSession()
        const nextSnap = nodes.value.map((n) => ({
          id: n.id,
          type: n.type,
          data: (n.data || {}) as Record<string, unknown>,
        }))
        agentRailRef.value?.reconcileFromNodes?.(nextSnap)
      } catch {
        // ignore
      }
      if (polls >= maxPolls) window.clearInterval(timer)
    })()
  }, 4000)
}

function resolveNewNodePosition(type: string) {
  const flow = vueFlowRef.value as {
    screenToFlowCoordinate?: (pos: { x: number; y: number }) => { x: number; y: number }
  } | null
  const canvasEl = document.querySelector('.canvas-flow') as HTMLElement | null
  if (!flow?.screenToFlowCoordinate || !canvasEl) {
    return {
      x: 280 + nodeCounter * 20,
      y: 180 + nodeCounter * 20,
    }
  }
  return computeNewNodePosition(
    type,
    nodes.value as unknown as FlowNode[],
    { screenToFlowCoordinate: flow.screenToFlowCoordinate.bind(flow) },
    canvasEl,
    {
      grid: viewportSettings.value.gridGap,
      dockStudioReserve: 80,
      snapToGrid: viewportSettings.value.snapToGrid,
    },
  )
}

const locateFlashNodeIds = ref<Set<string>>(new Set())

/** 拖拽开始时的 dragItems 位置快照（id → position），松手吸附算平移量用 */
let dragStartPositions = new Map<string, { x: number; y: number }>()

function triggerLocateFlash(ids: string[]) {
  locateFlashNodeIds.value = new Set(ids)
  setTimeout(() => {
    locateFlashNodeIds.value = new Set()
  }, 1200)
}

async function focusNodeById(id: string) {
  // 2026-10-01 修：节点尚未上屏（或已被删除）时点击定位是静默 no-op，
  // 必须给出与 focusNodesByIds 一致的提示，让定位失败可感知。
  const target = nodes.value.find((n) => n.id === id)
  if (!target) {
    ElMessage.warning('当前画布中没有找到对应节点')
    return
  }
  // 移动端：定位 = 用户显式要看画布 ⇒ 切到画布页签。
  // ADR-0011 T6（2026-10-20）：定位到**待确认**节点时进**纯画布满屏**（composer / SSE 全收）——
  // 此刻用户意图是「去画布上看 / 改提示词再确认」，不该与对话流同屏抢版面；其余定位仍走
  // 窗态（composer 同屏，供定位引图后继续输入，2026-10-18 裁决）。
  if (isMobileLayout.value) {
    // ⚠️ 2026-10-21 真机走查：入口语义只应在「**从对话页定位进画布**」时决定。
    // 已在画布视图里再定位（如 ＋sheet 创建节点后的自动聚焦 handleDockAdd →
    // focusNodeById）时，旧写法无条件重算 imm ⇒ 把纯画布切成窗态，composer 空闲条
    // 凭空冒出来（用户：「点 ＋ 添加节点时，这个不是窗操作，composer 空闲条不该出现」）。
    const enteringFromConversation = !mobileCanvasView.value
    mobileCanvasView.value = true
    mobileCanvasImm.value = enteringFromConversation
      ? isPendingConfirmNode(target as { data?: { status?: unknown } | undefined })
      : mobileCanvasImm.value
    mobileAppTab.value = 'canvas'
  }
  selectOnlyNode(id)
  await nextTick()
  await vueFlowRef.value?.fitView({ nodes: [id], padding: 0.45, duration: 320, maxZoom: 1.05 })
  triggerLocateFlash([id])
}

async function focusNodesByIds(ids: string[]) {
  const valid = ids.filter((id) => nodes.value.some((n) => n.id === id))
  if (!valid.length) {
    ElMessage.warning('当前画布中没有找到对应节点')
    return
  }
  if (valid.length === 1) return focusNodeById(valid[0])
  if (isMobileLayout.value) {
    // 同 focusNodeById：已在画布视图内定位不改入口语义（见该函数注释）
    const enteringFromConversation = !mobileCanvasView.value
    mobileCanvasView.value = true
    // ADR-0011 T6：批量定位里含待确认节点 ⇒ 同纯画布满屏（与单节点判据一致）
    mobileCanvasImm.value = enteringFromConversation
      ? valid.some((vid) =>
          isPendingConfirmNode(
            nodes.value.find((n) => n.id === vid) as {
              data?: { status?: unknown } | undefined
            },
          ),
        )
      : mobileCanvasImm.value
    mobileAppTab.value = 'canvas'
  }
  selectOnlyNode(valid[0])
  await nextTick()
  await vueFlowRef.value?.fitView({ nodes: valid, padding: 0.55, duration: 360, maxZoom: 1.0 })
  triggerLocateFlash(valid)
}

/** 发布弹窗「定位」：选中节点并聚焦；可选关闭弹窗 */
async function handlePublishLocateNode(payload: { sessionId: string; nodeId: string }) {
  if (payload.sessionId !== sessionId.value) {
    await router.push({
      name: 'canvas',
      params: { sessionId: payload.sessionId },
      query: { focusNode: payload.nodeId },
    })
    return
  }
  const node = nodes.value.find((n) => n.id === payload.nodeId)
  if (!node) {
    ElMessage.warning('当前画布中没有找到该节点')
    return
  }
  showPublish.value = false
  selectOnlyNode(payload.nodeId)
  await focusNodeById(payload.nodeId)
}

async function consumeAgentLaunchQuery() {
  const shouldOpen = route.query.openAgent === '1'
  const initial =
    typeof route.query.initialPrompt === 'string' ? route.query.initialPrompt.trim() : ''
  if (!shouldOpen && !initial) return
  await nextTick()
  if (shouldOpen) agentRailRef.value?.openPanel()
  if (initial) agentRailRef.value?.setComposerInput(initial)
  const nextQuery = { ...route.query }
  delete nextQuery.openAgent
  delete nextQuery.initialPrompt
  await router.replace({ query: nextQuery })
}

async function consumeFocusNodeQuery() {
  const focusId = typeof route.query.focusNode === 'string' ? route.query.focusNode : ''
  if (!focusId) return
  const node = nodes.value.find((n) => n.id === focusId)
  if (!node) {
    ElMessage.warning('当前画布中没有找到该节点')
  } else {
    selectOnlyNode(focusId)
    await focusNodeById(focusId)
  }
  const nextQuery = { ...route.query }
  delete nextQuery.focusNode
  await router.replace({ query: nextQuery })
}

function handleDockAdd(type: DockNodeType) {
  const position = resolveNewNodePosition(type)
  const id = createNodeAt(type, position)
  if (!id) return
  selectOnlyNode(id)
  persistUserEdit()
  void focusNodeById(id)
}

function selectOnlyNode(id: string) {
  pendingExclusiveSelectId = id
  selectNode(id)
  multiSelectedIds.value = [id]
  // fitView / connect-end 可能异步再抛 select change，短窗口内保持独占
  window.setTimeout(() => {
    if (pendingExclusiveSelectId === id) pendingExclusiveSelectId = null
  }, 400)
}

function syncMultiSelectionFromNodes() {
  if (pendingExclusiveSelectId) {
    const id = pendingExclusiveSelectId
    nodes.value = nodes.value.map((node) => {
      const selected = node.id === id
      return node.selected === selected ? node : { ...node, selected }
    })
    multiSelectedIds.value = [id]
    selectedNodeId.value = id
    return
  }
  const ids: string[] = []
  for (const node of nodes.value) {
    // 分组节点不进「节点选中」语义：它驱动的是分组工具条（解组 + 色卡）。
    // 塞进 selectedNodeId 会让 dock / studio 尝试打开一个 neoNodeMeta 里
    // 已不存在的 `group` 面板（表现为点一下分组弹出一个空白面板）。
    if (node.selected && !isGroupNode(node as unknown as FlowNode)) ids.push(node.id)
  }
  multiSelectedIds.value = ids
  if (ids.length === 1) {
    selectedNodeId.value = ids[0]
  } else {
    clearEditorSelection()
  }
}

/**
 * 受控模式下必须自行落地 nodesChange。
 * 注意：vue-flow 的 applyNodeChanges 对 position/dimensions 要求 isGraphNode
 *（带 computedPosition），而我们的 EditableFlowNode 是普通对象，直接 apply 会
 * 静默丢弃拖拽位移 → 鼠标是抓手但节点不动。这里对 plain node 显式应用变更。
 */
function onNodesChange(changes: NodeChange[]) {
  if (!changes.length) return

  // 引用拾取模式（2026-10-18 方案 A 裁决）：吞掉全部 select 变更——点节点只做「选为引用」，
  // 不落画布选中态。否则选中 → studio dock / 快捷工具行弹出，与拾取流互相踩（三带叠罗汉扳机）。
  // ADR-0011（2026-10-19）：propose pending_confirm 态的同类扳机已由 T4 门控消除
  // （dockGatedByPendingConfirm + ProposeConfirmOverlay 节点内联确认）；拾取模式的吞 select 保留。
  if (pickMode.active.value) {
    changes = changes.filter((change) => change.type !== 'select')
    if (!changes.length) return
  }

  let next = nodes.value
  let changed = false

  for (const change of changes) {
    if (change.type === 'position' && change.position) {
      const pos = change.position
      next = next.map((node) =>
        node.id === change.id ? { ...node, position: { x: pos.x, y: pos.y } } : node,
      )
      changed = true
    } else if (change.type === 'select') {
      next = next.map((node) =>
        node.id === change.id ? { ...node, selected: change.selected } : node,
      )
      changed = true
    } else if (change.type === 'remove') {
      rememberGenerationFieldsBeforeRemove([change.id])
      next = next.filter((node) => node.id !== change.id)
      changed = true
    } else if (change.type === 'add') {
      const item = change.item as EditableFlowNode
      if (!next.some((node) => node.id === item.id)) {
        next = [...next, { id: item.id, type: item.type, position: item.position, data: item.data, selected: item.selected }]
        changed = true
      }
    }
  }

  if (pendingExclusiveSelectId) {
    const id = pendingExclusiveSelectId
    next = next.map((node) => {
      const selected = node.id === id
      return node.selected === selected ? node : { ...node, selected }
    })
    changed = true
  }

  if (changed) nodes.value = next

  if (changes.some((change) => change.type === 'select') || pendingExclusiveSelectId) {
    syncMultiSelectionFromNodes()
  }
}

function onEdgesChange(changes: EdgeChange[]) {
  edges.value = applyEdgeChanges(changes, edges.value as any) as unknown as CanvasEdge[]
}

function onSelectionEnd() {
  // 框选允许多选，结束独占保护
  pendingExclusiveSelectId = null
  syncMultiSelectionFromNodes()
}

/**
 * 拖拽开始：快照所有 dragItems 的位置（供松手吸附算平移量用）。
 * vue-flow 的 dragItems 只含被抓节点与同批多选兄弟；已选父节点的子节点
 * 不在其中（相对坐标不变、随父移动），不该被平移。
 *
 * 分组整体拖拽时临时抬升 z 序：分组盒抬到 5、其子节点抬到 6 —— 否则
 * 拖着分组越过别的分组时，本组盒体会被对方子节点（z=1）压住。松手还原。
 */
function onNodeDragStart(event: NodeDragEvent) {
  dragStartPositions = new Map()
  for (const n of event.nodes) {
    dragStartPositions.set(n.id, { x: n.position.x, y: n.position.y })
  }
}

/**
 * 拖拽结束（2026-10-12 拖拽丝滑化）：拖拽中节点 1:1 跟手（VueFlow 的
 * snap-to-grid 已关），松手时才按 grid 吸附。先吸附再 resize 分组——
 * 顺序反了会按吸附前的位置算包围盒，松手后分组边框跳变。
 */
function onNodeDragStop(event: NodeDragEvent) {
  const node = event.node
  if (viewportSettings.value.snapToGrid && dragStartPositions.size > 0) {
    nodes.value = applySnapOnRelease(
      nodes.value as unknown as FlowNode[],
      dragStartPositions,
      node.id,
      viewportSettings.value.gridGap,
    ) as EditableFlowNode[]
    locateFlashNodeIds.value = new Set([node.id])
    window.setTimeout(() => {
      if (locateFlashNodeIds.value.has(node.id)) {
        locateFlashNodeIds.value = new Set()
      }
    }, 500)
  }
  dragStartPositions = new Map()
  // 分组是 vue-flow 父节点：拖子节点到边缘会 expandParent 撑大框 ⇒ 拖完贴回包围盒。
  fitGroups()
  persistUserEdit()
}

function onNodeClick(event: NodeMouseEvent) {
  // 长按抑制窗（D-6）：长按出上下文菜单后松手的合成 click 直接吞掉
  if (Date.now() < clickSuppressUntil.value) return

  if (pickMode.active.value) {
    const nodeId = event.node.id
    const node = findNodeById(nodeId)
    if (!node) return
    const result = agentRailRef.value?.addFromCanvasNodes([{
      id: node.id,
      type: node.type,
      data: (node.data ?? {}) as Record<string, unknown>,
    }]) ?? { added: 0, empty: 0, duplicate: 0, addedNodeIds: [] }
    if (result.added > 0) {
      for (const id of result.addedNodeIds) pickMode.markPicked(id)
    } else if (result.empty) {
      pickRejectNodeId.value = nodeId
      window.setTimeout(() => {
        if (pickRejectNodeId.value === nodeId) pickRejectNodeId.value = null
      }, 400)
    } else if (result.duplicate) {
      ElMessage.info('该节点已在引用中')
    }
    return
  }

  // 多选模式（D-4）：点选切换；不开单节点 dock（S2/S3 互斥）
  if (mobileMultiSelectActive.value) {
    toggleNodeInMultiSelect(event.node.id)
    return
  }

  const mouse = event.event as MouseEvent
  const multi = mouse.shiftKey || mouse.metaKey || mouse.ctrlKey
  // 点节点 = 退出分组选中态（分组工具条与节点工具条互斥，避免两个都挂着）。
  clearGroupSelection()
  if (!multi) {
    // 单击独占选中，避免「拖出下游后源+目标双选 → dock 不出现 / 出现多选 +」
    selectOnlyNode(event.node.id)
  } else {
    pendingExclusiveSelectId = null
    syncMultiSelectionFromNodes()
  }
  closeContextMenu()
}

/**
 * 删除选区。
 *
 * 分组走「解组」语义而不是级联删除：vue-flow 移除父节点**不会**连带处理子节点，
 * 直接删 group 节点会让子节点 parentNode 悬空（坐标退化成相对值、整组错位）。
 * 产品语义也一直是「删框留节点」，所以这里先 ungroup 再删其余节点。
 */
function handleDeleteSelection() {
  const ids = [...multiSelectedIds.value]
  const isGroup = (id: string) =>
    isGroupNode(nodes.value.find((n) => n.id === id) as unknown as FlowNode)
  const groupIds = ids.filter(isGroup)
  let working = flowNodes.value
  for (const groupId of groupIds) {
    working = ungroupById(working, groupId) ?? working
  }
  const toRemove = new Set(ids.filter((id) => !groupIds.includes(id)))
  rememberGenerationFieldsBeforeRemove(toRemove)
  nodes.value = working.filter((n) => !toRemove.has(n.id)) as EditableFlowNode[]
  const nextEdges: CanvasEdge[] = []
  for (const edge of edges.value) {
    if (!toRemove.has(edge.source) && !toRemove.has(edge.target)) nextEdges.push(edge)
  }
  edges.value = nextEdges
  // 被删节点要从分组里摘掉，剩余不足 2 个的分组自动解散。
  forgetGroupsForRemovedNodes(toRemove)
  multiSelectedIds.value = []
  clearSelection()
  persistUserEdit()
}

function handleLayoutSelection(mode: 'along_edges' | 'grid') {
  const selected = multiSelectedIds.value
  const current = nodes.value as unknown as FlowNode[]
  const next =
    mode === 'along_edges'
      ? layoutNodesAlongEdges(
          current,
          edges.value.map((e) => ({ source: e.source, target: e.target })),
          selected,
        )
      : layoutNodesInGrid(current, selected)
  nodes.value = next as EditableFlowNode[]
  persistUserEdit()
}

/**
 * agent 工具 `arrange_nodes`（SSE canvas_command → AgentSideRail emit）的消费端。
 * 坐标类变更必须在前端执行（画布活动态 nodes.value 是真相源，走 Nest 改库会被下一次
 * saveCanvas 整份覆盖），故这里算完 setNodes 后 persistUserEdit（落 undo 栈 + 存库）。
 * 排完自动聚焦：不聚焦的话节点可能落在视口外，用户看不到变化（focus_node 工具保留独立）。
 */
async function handleArrangeNodes(payload: {
  nodeIds: string[]
  mode: 'along_edges' | 'grid'
  gap?: number
  edges?: { source: string; target: string }[]
}) {
  const ids = (payload?.nodeIds ?? []).filter((id) => typeof id === 'string' && id)
  if (ids.length < 2) return
  if (agentReadOnly.value) {
    ElMessage.warning('此画布属于其他账号，Agent 无法整理画布')
    return
  }
  const current = nodes.value as unknown as FlowNode[]
  const next = applyArrangeLayout(current, payload, edges.value.map((e) => ({ source: e.source, target: e.target })))
  nodes.value = next as EditableFlowNode[]
  persistUserEdit()
  await nextTick()
  await focusNodesByIds(ids)
}

function findSelectedNodes() {
  const out: EditableFlowNode[] = []
  for (const id of multiSelectedIds.value) {
    const node = findNodeById(id)
    if (node) out.push(node)
  }
  return out
}

function pickTextSourceNode(selected: EditableFlowNode[]) {
  for (const node of selected) {
    const type = String(node.type ?? '')
    if (type === 'text' || type === 'prompt') return node
  }
  return null
}

function pickImageSourceNode(selected: EditableFlowNode[]) {
  for (const node of selected) {
    const type = String(node.type ?? '')
    const data = node.data as Record<string, unknown>
    const url = String(data.url ?? '').trim()
    if (type === 'image' && url) return node
  }
  return null
}

function connectNodes(sourceId: string, targetId: string) {
  const edgeId = `e-${sourceId}-${targetId}`
  if (edges.value.some((edge) => edge.id === edgeId)) return
  addEdge({ id: edgeId, source: sourceId, target: targetId })
}

async function handleGenerateVideoFromSelection() {
  const selected = findSelectedNodes()
  const textNode = pickTextSourceNode(selected)
  const imageNode = pickImageSourceNode(selected)
  if (!textNode || !imageNode) return

  const textData = textNode.data as Record<string, unknown>
  const prompt = String(textData.content ?? textData.prompt ?? '').trim()
  if (!prompt) return
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }

  const imageUrl = String((imageNode.data as Record<string, unknown>).url ?? '').trim()
  const videoModel = getProviderConfig('video').model
  const bounds = getSelectionBounds(nodes.value as unknown as FlowNode[], multiSelectedIds.value)
  const { w } = getNodeSize({ type: 'video' } as FlowNode)
  const position = bounds
    ? { x: bounds.centerX - w / 2, y: bounds.bottomY + 36 }
    : resolveNewNodePosition('video')

  const id = addNode('video', {
    url: '',
    status: 'idle',
    prompt,
    videoModel,
    referenceImageUrl: imageUrl,
  }, { position })

  connectNodes(textNode.id, id)
  connectNodes(imageNode.id, id)

  selectOnlyNode(id)
  persistUserEdit()
  await nextTick()
  await focusNodeById(id)
  await handleNodeGenerate()
}

function onPaneClick() {
  if (applyRefineSelectionDecision(null) === 'block') return
  // 多选模式（D-4）：点空白 = 退出 S3（连同清除选择）
  exitMultiSelectMode()
  pendingExclusiveSelectId = null
  multiSelectedIds.value = []
  // 点空白 = 取消分组选中（否则分组工具条会一直挂着）。
  clearGroupSelection()
  selectedEdgeId.value = null
  clearSelection()
  closeContextMenu()
  closeBlankNodePicker()
  closeBatchConnectPicker()
}

function onPaneDoubleClick(event: MouseEvent) {
  if (viewportSettings.value.viewLocked) return
  const target = event.target as HTMLElement
  if (target.closest('.vue-flow__node')) return
  blankNodePicker.value = { x: event.clientX, y: event.clientY }
}

function onEdgeClick({ edge, event }: EdgeMouseEvent) {
  multiSelectedIds.value = []
  clearSelection()
  selectedEdgeId.value = edge.id
  const coords = getEventCoords(event)
  selectedEdgePos.value = { x: coords.x, y: coords.y }
  closeContextMenu()
}

function deleteEdgeById(edgeId: string) {
  edges.value = edges.value.filter((edge) => edge.id !== edgeId)
  if (selectedEdgeId.value === edgeId) selectedEdgeId.value = null
  persistUserEdit()
}

function renameNodeById(nodeId: string, title: string) {
  const node = findNodeById(nodeId)
  if (!node) return
  const type = String(node.type ?? '')
  if (type === 'text' || type === 'prompt') {
    patchNodeData(nodeId, { title, label: title })
  } else {
    patchNodeData(nodeId, { title })
  }
  persistUserEdit()
}

provide(CANVAS_NODE_LOCATE_FLASH_KEY, locateFlashNodeIds)
provide(CANVAS_NODE_RENAME_KEY, renameNodeById)

function patchNodeMediaById(nodeId: string, patch: Record<string, unknown>) {
  patchNodeData(nodeId, patch)
  persistUserEdit()
}

provide(CANVAS_NODE_PATCH_KEY, patchNodeMediaById)

provide(CANVAS_NODE_ADD_AGENT_KEY, (nodeId: string) => {
  handleAddToAgentRefs([nodeId])
})

/** 长按节点 → 统一上下文菜单（D-6）：移动端出底部动作 sheet，PC 仍走右键小浮层 */
provide(CANVAS_NODE_OPEN_CONTEXT_MENU_KEY, (nodeId: string) => {
  const node = findNodeById(nodeId)
  if (!node) return
  const data = (node.data ?? {}) as Record<string, unknown>
  contextMenu.value = {
    x: 0,
    y: 0,
    nodeId,
    nodeType: String(node.type ?? ''),
    nodeTitle: resolveNeoNodeTitle(String(node.type ?? ''), data),
    hasUrl: Boolean(String(data.url ?? '').trim()),
    mediaKind: typeof data.mediaKind === 'string' ? data.mediaKind : undefined,
    mimeType: typeof data.mimeType === 'string' ? data.mimeType : undefined,
  }
})

/** 长按 click 抑制窗（D-6）：节点长按触发后 350ms 内的合成 click 由页面级 @node-click 吞掉 */
const clickSuppressUntil = ref(0)
provide(CANVAS_NODE_CLICK_GUARD_KEY, {
  markSuppressed: () => {
    clickSuppressUntil.value = Date.now() + 350
  },
  shouldSuppress: () => Date.now() < clickSuppressUntil.value,
})

/**
 * 移动端多选模式（D-4）：长按节点 → 上下文 sheet「多选」进入；此后点选切换、
 * 已选节点带勾选徽标；点空白退出。与 S2 单节点 dock 互斥（editorNode /
 * selectionActionBarNode 在该态返回 null），vue-flow 内部选中态关闭
 * （nodes-selectable=false），选择完全由应用层驱动。
 */
const mobileMultiSelectActive = ref(false)
provide(CANVAS_MULTI_SELECT_ACTIVE_KEY, mobileMultiSelectActive)

const renameRequestNodeId = ref<string | null>(null)
provide(CANVAS_NODE_RENAME_REQUEST_KEY, renameRequestNodeId)

function enterMultiSelectMode(seedId: string) {
  // 已在多选态：长按另一节点 = 把它**加入/移出**选区，而不是重置整份选区。
  // 2026-10-21 真机走查：长按 A → sheet「多选」→ 再长按 B ⇒ 旧行为走
  // selectNodeIds([B]) → selectOnlyNode(B) ⇒ A 被取消，只剩 B，多选退化成单选。
  if (mobileMultiSelectActive.value) {
    toggleNodeInMultiSelect(seedId)
    return
  }
  mobileMultiSelectActive.value = true
  selectNodeIds([seedId])
}

function exitMultiSelectMode() {
  if (!mobileMultiSelectActive.value) return
  mobileMultiSelectActive.value = false
  multiSelectedIds.value = []
  clearSelection()
}

function toggleNodeInMultiSelect(id: string) {
  const set = new Set(multiSelectedIds.value)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  pendingExclusiveSelectId = null
  nodes.value = nodes.value.map((node) => {
    const selected = set.has(node.id)
    return node.selected === selected ? node : { ...node, selected }
  })
  syncMultiSelectionFromNodes()
}

function resolveDropPosition(clientPos: { x: number; y: number }, nodeType: string) {
  const flowPoint = screenToFlowPoint(clientPos.x, clientPos.y)
  const { w, h } = getNodeSize({ type: nodeType } as FlowNode)
  const grid = viewportSettings.value.gridGap
  const snap = viewportSettings.value.snapToGrid
  return {
    x: snap ? snapToGrid(flowPoint.x - w / 2, grid) : flowPoint.x - w / 2,
    y: snap ? snapToGrid(flowPoint.y - h / 2, grid) : flowPoint.y - h / 2,
  }
}

const LOCAL_REF_TARGET_TYPES = new Set(['text', 'prompt', 'image', 'video', 'audio'])

function createLocalRefId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function appendLocalRef(nodeId: string, binding: LocalRefBinding) {
  const node = findNodeById(nodeId)
  const prev = (node?.data?.localRefs as LocalRefBinding[]) ?? []
  patchNodeData(nodeId, { localRefs: [...prev, binding] })
}

function canAcceptLocalRef(nodeType: string, mediaType: LocalRefBinding['mediaType']): boolean {
  if (!LOCAL_REF_TARGET_TYPES.has(nodeType)) return false
  if (mediaType === 'text') return nodeType === 'text' || nodeType === 'prompt'
  if (mediaType === 'image') return nodeType === 'text' || nodeType === 'image' || nodeType === 'video'
  if (mediaType === 'video') return nodeType === 'video'
  if (mediaType === 'audio') return nodeType === 'audio' || nodeType === 'video'
  return false
}

function previewPatchForLocalRef(
  nodeType: string,
  mediaType: LocalRefBinding['mediaType'],
  url: string,
): Record<string, unknown> {
  if (mediaType === 'image' && nodeType === 'image') return { url, status: 'completed' }
  if (mediaType === 'image' && nodeType === 'video') return { videoMode: 'image_to_video' }
  if (mediaType === 'video' && nodeType === 'video') return { url, status: 'completed' }
  if (mediaType === 'audio' && nodeType === 'audio') return { url, status: 'completed' }
  // audio → video：仅作引用芯片，不覆盖成片 url
  if (mediaType === 'audio' && nodeType === 'video') return {}
  return {}
}

function applyLocalRefToSelectedNode(binding: LocalRefBinding): boolean {
  const node = editorNode.value
  if (!node) return false
  const nodeType = String(node.type ?? '')
  if (!canAcceptLocalRef(nodeType, binding.mediaType)) return false

  appendLocalRef(node.id, binding)
  const previewPatch = previewPatchForLocalRef(nodeType, binding.mediaType, binding.url ?? '')
  if (Object.keys(previewPatch).length) patchNodeData(node.id, previewPatch)
  persistUserEdit()
  return true
}

function assetPayloadFromItem(asset: CanvasAssetItem): MediaFilePayload | null {
  if (asset.kind !== 'image' && asset.kind !== 'video' && asset.kind !== 'audio') return null
  return {
    url: asset.url,
    fileName: asset.label,
    mimeType: asset.kind === 'video' ? 'video/mp4' : asset.kind === 'audio' ? 'audio/mpeg' : 'image/png',
    kind: asset.kind,
  }
}

function tryApplyAssetToSelectedNode(asset: CanvasAssetItem): boolean {
  if (asset.kind !== 'image' && asset.kind !== 'video' && asset.kind !== 'audio') return false
  const payload = assetPayloadFromItem(asset)
  if (!payload) return false
  return applyLocalRefToSelectedNode({
    id: createLocalRefId('asset'),
    mediaType: asset.kind,
    sourceKind: 'asset',
    label: asset.label,
    url: payload.url,
  })
}

function tryApplyUploadToSelectedNode(payload: MediaFilePayload): boolean {
  if (payload.kind === 'other') return false
  const binding: LocalRefBinding = {
    id: createLocalRefId('upload'),
    mediaType: payload.kind,
    sourceKind: 'upload',
    label: payload.fileName,
    url: payload.url,
  }
  if (payload.kind === 'text') binding.text = payload.textContent ?? ''
  return applyLocalRefToSelectedNode(binding)
}

async function createFileNodeAt(payload: MediaFilePayload, clientPos: { x: number; y: number }) {
  if (payload.kind === 'other') return

  const title = payload.fileName.replace(/\.[^.]+$/, '') || payload.fileName
  const meta = {
    fileName: payload.fileName,
    mimeType: payload.mimeType,
    title,
  }
  const mediaStatus = payload.url
    ? { url: payload.url, status: 'completed' }
    : { status: 'error', errorMessage: '文件上传失败，请重试', errorCode: 'upload_required' }
  let id: string | null = null

  switch (payload.kind) {
    case 'text':
      id = addNode('text', {
        content: payload.textContent ?? '',
        ...meta,
        status: 'completed',
        textModel: getProviderConfig('text').model,
      }, { position: resolveDropPosition(clientPos, 'text') })
      break
    case 'image':
      id = addNode('image', {
        ...mediaStatus,
        ...meta,
        prompt: '',
        imageModel: getProviderConfig('image').model,
        imageAspect: preferences.value?.defaultImageAspect || '16:9',
        imageResolution: preferences.value?.defaultImageResolution || '1K',
        imageCount: 1,
      }, { position: resolveDropPosition(clientPos, 'image') })
      break
    case 'video':
      id = addNode('video', {
        ...mediaStatus,
        ...meta,
        prompt: '',
        videoModel: getProviderConfig('video').model,
        videoSettings: {
          aspectRatio: preferences.value?.defaultVideoAspect || '16:9',
          duration: preferences.value?.defaultVideoDuration || 5,
          resolution: preferences.value?.defaultVideoResolution || '720p',
          crop: preferences.value?.defaultVideoCrop || 'none',
        },
      }, { position: resolveDropPosition(clientPos, 'video') })
      break
    case 'audio':
      id = addNode('audio', {
        ...mediaStatus,
        ...meta,
        prompt: '',
        audioModel: getProviderConfig('audio').model,
        audioVoice: preferences.value?.audioVoice || 'female-shaonv',
        audioFormat: preferences.value?.audioFormat || 'mp3',
        audioSpeed: preferences.value?.audioSpeed ?? 1,
        ...(preferences.value?.audioInstructions
          ? { audioInstructions: preferences.value.audioInstructions }
          : {}),
      }, { position: resolveDropPosition(clientPos, 'audio') })
      break
  }

  if (!id) return
  selectOnlyNode(id)
  persistUserEdit()
  await focusNodeById(id)
}

function createUploadingMediaNodeAt(
  file: File,
  clientPos: { x: number; y: number },
  kind: 'image' | 'video' | 'audio',
): string | null {
  const title = file.name.replace(/\.[^.]+$/, '') || file.name
  const meta = {
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    title,
  }
  const uploading = { status: 'uploading', uploadProgress: 0, prompt: '' }

  switch (kind) {
    case 'image':
      return addNode('image', {
        ...meta,
        ...uploading,
        imageModel: getProviderConfig('image').model,
        imageAspect: preferences.value?.defaultImageAspect || '16:9',
        imageResolution: preferences.value?.defaultImageResolution || '1K',
        imageCount: 1,
      }, { position: resolveDropPosition(clientPos, kind) })
    case 'video':
      return addNode('video', {
        ...meta,
        ...uploading,
        videoModel: getProviderConfig('video').model,
        videoSettings: {
          aspectRatio: preferences.value?.defaultVideoAspect || '16:9',
          duration: preferences.value?.defaultVideoDuration || 5,
          resolution: preferences.value?.defaultVideoResolution || '720p',
          crop: preferences.value?.defaultVideoCrop || 'none',
        },
      }, { position: resolveDropPosition(clientPos, kind) })
    case 'audio':
      return addNode('audio', {
        ...meta,
        ...uploading,
        audioModel: getProviderConfig('audio').model,
        audioVoice: preferences.value?.audioVoice || 'female-shaonv',
        audioFormat: preferences.value?.audioFormat || 'mp3',
        audioSpeed: preferences.value?.audioSpeed ?? 1,
        ...(preferences.value?.audioInstructions
          ? { audioInstructions: preferences.value.audioInstructions }
          : {}),
      }, { position: resolveDropPosition(clientPos, kind) })
    default:
      return null
  }
}

async function ingestMediaFile(file: File, clientPos: { x: number; y: number }) {
  const kind = detectFileKind(file)
  if (kind === 'other') {
    ElMessage.warning('不支持的文件类型')
    return
  }

  const selectedNode = editorNode.value
  const wouldApplyToSelected =
    !!selectedNode &&
    (kind === 'text'
      ? canAcceptLocalRef(String(selectedNode.type ?? ''), 'text')
      : canAcceptLocalRef(String(selectedNode.type ?? ''), kind))

  const selectedNodeId = wouldApplyToSelected ? selectedNode!.id : null
  const isMediaKind = kind === 'image' || kind === 'video' || kind === 'audio'

  let uploadingNodeId: string | null = null
  if (!wouldApplyToSelected && isMediaKind) {
    uploadingNodeId = createUploadingMediaNodeAt(file, clientPos, kind)
    if (uploadingNodeId) {
      selectOnlyNode(uploadingNodeId)
      // Graph add is undoable; upload progress / url patches skip history.
      canvasUndo.commitAfterChange()
    }
  }

  if (selectedNodeId && isMediaKind) {
    patchNodeData(selectedNodeId, {
      status: 'uploading',
      uploadProgress: 0,
      errorMessage: undefined,
      errorCode: undefined,
    })
  }

  try {
    const payload = await fileToPersistedPayload(file, {
      onProgress: (p) => {
        if (uploadingNodeId) patchNodeData(uploadingNodeId, { uploadProgress: p })
        if (selectedNodeId && isMediaKind) patchNodeData(selectedNodeId, { uploadProgress: p })
      },
    })

    if (payload.url && tryApplyUploadToSelectedNode(payload)) {
      if (selectedNodeId && isMediaKind) {
        patchNodeData(selectedNodeId, { uploadProgress: undefined, status: 'idle' })
      }
      return
    }

    if (uploadingNodeId) {
      patchNodeData(uploadingNodeId, {
        url: payload.url,
        status: 'completed',
        uploadProgress: undefined,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
      })
      void saveCanvas()
      await focusNodeById(uploadingNodeId)
      return
    }

    await createFileNodeAt(payload, clientPos)
  } catch (err) {
    const msg = err instanceof Error ? err.message : '上传失败'
    if (uploadingNodeId) {
      patchNodeData(uploadingNodeId, {
        status: 'error',
        errorMessage: msg,
        errorCode: 'upload_required',
        uploadProgress: undefined,
      })
      void saveCanvas()
      return
    }
    if (wouldApplyToSelected) {
      if (selectedNodeId && isMediaKind) {
        patchNodeData(selectedNodeId, { uploadProgress: undefined, status: 'idle' })
      }
      ElMessage.error(msg)
      return
    }
    if (kind === 'text') {
      ElMessage.error(msg)
      return
    }
    await createFileNodeAt(
      {
        url: '',
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        kind,
      },
      clientPos,
    )
  }
}

async function handleDockFileDrop(file: File) {
  let closeToast: () => void = () => {}
  const showProgress = (pct: number) => {
    closeToast()
    const toast = ElMessage.info({
      message: pct > 0 ? `上传 ${pct}%` : '上传中...',
      duration: 0,
      showClose: false,
    })
    closeToast = () => {
      toast.close()
    }
  }

  try {
    showProgress(0)
    const payload = await fileToPersistedPayload(file, {
      onProgress: showProgress,
    })
    closeToast()

    if (payload.kind !== 'image' && payload.kind !== 'video' && payload.kind !== 'audio') {
      ElMessage.warning('当前节点不支持该类型的引用')
      return
    }

    const binding: LocalRefBinding = {
      id: createLocalRefId('upload'),
      mediaType: payload.kind,
      sourceKind: 'upload',
      label: payload.fileName,
      url: payload.url,
    }

    if (!applyLocalRefToSelectedNode(binding)) {
      ElMessage.warning('当前节点不支持该类型的引用')
    }
  } catch (err) {
    closeToast()
    ElMessage.error(err instanceof Error ? err.message : '上传失败')
  }
}

async function handleContinueShot() {
  const node = editorNode.value
  if (!node || node.type !== 'video') return
  const data = node.data ?? {}
  const lastFrameUrl = String(data.lastFrameUrl ?? '').trim()
  if (!lastFrameUrl) return

  const prompt = String(data.prompt ?? data.content ?? '').trim()
  const videoModel = String(data.videoModel ?? getProviderConfig('video').model)
  const videoSettings =
    data.videoSettings && typeof data.videoSettings === 'object'
      ? { ...(data.videoSettings as Record<string, unknown>) }
      : {
          aspectRatio: preferences.value?.defaultVideoAspect || '16:9',
          duration: preferences.value?.defaultVideoDuration || 5,
          resolution: preferences.value?.defaultVideoResolution || '720p',
          crop: preferences.value?.defaultVideoCrop || 'none',
        }

  const { w } = getNodeSize(node as FlowNode)
  const position = {
    x: node.position.x + w + 36,
    y: node.position.y,
  }

  const binding: LocalRefBinding = {
    id: createLocalRefId('last-frame'),
    mediaType: 'image',
    sourceKind: 'upload',
    label: '上一镜末帧',
    url: lastFrameUrl,
  }

  const childId = addNode(
    'video',
    {
      url: '',
      status: 'idle',
      prompt,
      videoModel,
      videoSettings,
      videoMode: 'image_to_video',
      localRefs: [binding],
      refOrder: [binding.id],
    },
    { position },
  )

  addEdge({
    id: `e-${node.id}-${childId}`,
    source: node.id,
    target: childId,
  })
  selectOnlyNode(childId)
  persistUserEdit()
  await focusNodeById(childId)
}

/** 历史记录「定位」：优先 nodeId，再按 generationRecordId / materialId 反查 */
async function handleHistoryLocate(payload: string | { recordId: string; nodeId?: string | null }) {
  const recordId = typeof payload === 'string' ? payload : payload.recordId
  const nodeId = typeof payload === 'string' ? undefined : payload.nodeId
  const node =
    (nodeId && nodes.value.find((n) => n.id === nodeId)) ||
    nodes.value.find((n) => {
      const data = n.data as Record<string, unknown>
      return data.generationRecordId === recordId || data.materialId === recordId
    })
  if (!node) {
    ElMessage.warning('当前画布中没有找到该任务对应的节点')
    return
  }
  selectOnlyNode(node.id)
  await focusNodeById(node.id)
}

function handleHistoryRetry(nodeId: string) {
  void retryNodeGeneration(nodeId)
}

async function handleAssetApply(asset: CanvasAssetItem) {
  if (tryApplyAssetToSelectedNode(asset)) return

  const center = canvasAreaRef.value?.getBoundingClientRect()
  const clientPos = {
    x: center ? center.left + center.width / 2 : window.innerWidth / 2,
    y: center ? center.top + center.height / 2 : window.innerHeight / 2,
  }
  const payload = assetPayloadFromItem(asset)
  if (payload) await createFileNodeAt(payload, clientPos)
}

function handleAssetAddToAgent(asset: CanvasAssetItem) {
  if (asset.kind === 'other') return
  agentRailRef.value?.addAttachment({
    id: asset.id,
    mediaType: asset.kind,
    sourceKind: 'asset',
    label: asset.label,
    url: asset.url,
  })
  agentRailRef.value?.openPanel()
}

async function handlePackageDownload(mode: WorkflowExportMode = 'full_package') {
  await exportWorkflowPackage({
    nodes: nodes.value.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      parentNode: n.parentNode,
      data: n.data as Record<string, unknown>,
    })),
    edges: edges.value.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    selectedIds: [...multiSelectedIds.value],
    sessionId: sessionId.value,
    exportMode: mode,
  })
}

async function handleExportPack(
  nodeIds: string[],
  exportMode: 'full_package' | 'lightweight' = 'full_package',
) {
  // Empty nodeIds = full canvas (exportWorkflowPackage expands selectedIds).
  await exportWorkflowPackage({
    nodes: nodes.value.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      parentNode: n.parentNode,
      data: n.data as Record<string, unknown>,
    })),
    edges: edges.value.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    selectedIds: nodeIds,
    sessionId: sessionId.value,
    exportMode,
  })
}

function openWorkflowImportPicker() {
  workflowImportInputRef.value?.click()
}

async function onWorkflowImportSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  try {
    await importWorkflowPackage(file, {
      nodes: nodes.value.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        parentNode: n.parentNode,
        data: n.data as Record<string, unknown>,
      })),
      edges: edges.value.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      sessionId: sessionId.value,
      createId: (type) => {
        nodeCounter++
        return `${type}-${nodeCounter}`
      },
      getViewport: () => vueFlowRef.value?.getViewport?.() ?? { x: 0, y: 0, zoom: 1 },
      getContainerSize: () => {
        const el = vueFlowRef.value?.$el as HTMLElement | undefined
        const rect = el?.getBoundingClientRect?.()
        return { width: rect?.width || 1000, height: rect?.height || 800 }
      },
      fitImportedNodes: async (ids) => {
        await nextTick()
        try {
          const flow = vueFlowRef.value as {
            findNode?: (id: string) => { id: string; dimensions?: { width: number; height: number } } | undefined
            fitView?: (opts: { nodes: string[]; padding: number; duration: number }) => Promise<boolean | void>
            fitBounds?: (
              bounds: { x: number; y: number; width: number; height: number },
              opts: { padding: number; duration: number },
            ) => Promise<unknown>
            updateNodeInternals?: (ids?: string[] | string) => void
          } | null
          if (!flow?.fitView || !flow.fitBounds) return
          await fitImportedViewport({
            ids,
            nodes: nodes.value.map((n) => ({
              id: n.id,
              position: n.position,
              parentNode: (n as { parentNode?: string }).parentNode,
            })),
            getMeasuredNode: (id) => flow.findNode?.(id),
            fitView: (opts) => flow.fitView!(opts),
            fitBounds: (bounds, opts) => flow.fitBounds!(bounds, opts),
            updateNodeInternals: (nodeIds) => flow.updateNodeInternals?.(nodeIds),
          })
        } catch {
          // ignore
        }
      },
      applyMerge: (mergeNodes, mergeEdges) => {
        for (const n of mergeNodes) {
          nodes.value.push({
            id: n.id,
            type: n.type,
            position: n.position,
            ...(n.parentNode
              ? {
                  parentNode: n.parentNode,
                  ...(n.extent !== undefined ? { extent: n.extent } : {}),
                  ...(n.expandParent !== undefined ? { expandParent: n.expandParent } : {}),
                }
              : {}),
            data: { createdAt: Date.now(), ...(n.data ?? {}) },
          })
        }
        for (const e of mergeEdges) {
          edges.value.push({ id: e.id, source: e.source, target: e.target })
        }
        persistUserEdit()
      },
    })
  } catch {
    // toast already shown inside importWorkflowPackage
  }
}

function connectSelectionToTarget(targetId: string, sourceIds = multiSelectedIds.value) {
  for (const sourceId of sourceIds) {
    if (sourceId === targetId) continue
    connectNodes(sourceId, targetId)
  }
  persistUserEdit()
}

function handleMultiConnectTarget(targetId: string) {
  connectSelectionToTarget(targetId)
}

function handleMultiConnectBlank(clientX: number, clientY: number) {
  batchConnectPicker.value = {
    sourceIds: [...multiSelectedIds.value],
    x: clientX,
    y: clientY,
  }
}

function closeBatchConnectPicker() {
  batchConnectPicker.value = null
}

function handleBatchConnectPickerSelect(type: DockNodeType) {
  const picker = batchConnectPicker.value
  if (!picker) return
  batchConnectPicker.value = null

  const flowPoint = screenToFlowPoint(picker.x, picker.y)
  const { w, h } = getNodeSize({ type } as FlowNode)
  const grid = viewportSettings.value.gridGap
  const snap = viewportSettings.value.snapToGrid
  const position = {
    x: snap ? snapToGrid(flowPoint.x - w / 2, grid) : flowPoint.x - w / 2,
    y: snap ? snapToGrid(flowPoint.y - h / 2, grid) : flowPoint.y - h / 2,
  }

  const id = createNodeAt(type, position)
  if (!id) return

  connectSelectionToTarget(id, picker.sourceIds)
  selectOnlyNode(id)
  void focusNodeById(id)
}

function handleKeyboardDelete() {
  if (selectedEdgeId.value) {
    deleteEdgeById(selectedEdgeId.value)
    return
  }
  if (multiSelectedIds.value.length) {
    handleDeleteSelection()
  }
}

function handleKeyboardDuplicate() {
  const contextId =
    multiSelectedIds.value.length > 0
      ? multiSelectedIds.value[0]
      : selectedNodeId.value ?? undefined
  if (!contextId) return
  handleDuplicateSelection(contextId, 'none')
}

function handleToolbarDuplicateUpstream() {
  const contextId = multiSelectedIds.value[0]
  if (!contextId) return
  handleDuplicateSelection(contextId, 'upstream')
}

function panViewport(dx: number, dy: number) {
  const flow = vueFlowRef.value as {
    getViewport?: () => { x: number; y: number; zoom: number }
    setViewport?: (viewport: { x: number; y: number; zoom: number }, options?: { duration?: number }) => void
  } | null
  if (!flow?.getViewport || !flow?.setViewport) return
  const vp = flow.getViewport()
  flow.setViewport({ ...vp, x: vp.x + dx, y: vp.y + dy }, { duration: 0 })
}

function zoomViewport(delta: number) {
  const flow = vueFlowRef.value as {
    getViewport?: () => { x: number; y: number; zoom: number }
    zoomTo?: (zoom: number, options?: { duration?: number }) => void
  } | null
  if (!flow?.getViewport || !flow?.zoomTo) return
  const next = Math.min(2, Math.max(0.1, flow.getViewport().zoom * delta))
  flow.zoomTo(next, { duration: 120 })
}

useCanvasKeyboard({
  enabled: canvasInteractionEnabled,
  onZoomIn: () => zoomViewport(1.12),
  onZoomOut: () => zoomViewport(1 / 1.12),
  onPan: panViewport,
  onDelete: handleKeyboardDelete,
  onDuplicate: handleKeyboardDuplicate,
  onUndo: () => {
    if (canvasUndo.undo()) void saveCanvas()
  },
  onRedo: () => {
    if (canvasUndo.redo()) void saveCanvas()
  },
})

function handleAgentUndo() {
  if (canvasUndo.undo()) void saveCanvas()
}

function handleAgentRedo() {
  if (canvasUndo.redo()) void saveCanvas()
}

function imageVersionStateFromData(data: Record<string, unknown>) {
  const currentVersionId = typeof data.currentVersionId === 'string' ? data.currentVersionId : undefined
  const generationRecordId = typeof data.generationRecordId === 'string' ? data.generationRecordId : undefined
  const imageVersions = Array.isArray(data.imageVersions)
    ? (data.imageVersions as ImageVersionEntry[])
    : undefined
  return {
    url: String(data.url ?? '').trim(),
    currentVersionId,
    imageVersions,
    generationRecordId,
  }
}

function seedRefineIfNeeded(node: EditableFlowNode) {
  const data = (node.data ?? {}) as Record<string, unknown>
  const state = imageVersionStateFromData(data)
  if (!state.url || (state.imageVersions?.length ?? 0) > 0) return
  const source = !state.generationRecordId ? 'upload' : 'generate'
  const seeded = seedImageVersions(state, { source })
  patchNodeData(node.id, {
    currentVersionId: seeded.currentVersionId,
    imageVersions: seeded.imageVersions,
  })
}

function applyRefineSelectionDecision(selectedId: string | null) {
  const decision = decideRefineDismiss({
    busy: canvasEditor.refineBusy,
    targetNodeId: canvasEditor.imageTarget?.nodeId ?? null,
    selectedNodeId: selectedId,
  })
  if (decision === 'block') {
    const targetId = canvasEditor.imageTarget?.nodeId
    if (targetId) selectOnlyNode(targetId)
    return decision
  }
  if (decision === 'dismiss') canvasEditor.closeImageEditor()
  return decision
}

function openRefineForNode(node: EditableFlowNode | null | undefined) {
  if (!CX_IMAGE_EDIT_ENABLED || !node) return
  if (gridSlicePanelNodeId.value || gridSliceBusy.value) {
    ElMessage.warning('请先退出宫格裁剪')
    return
  }
  const data = (node.data ?? {}) as Record<string, unknown>
  if (
    !canOpenRefineForNode({
      type: String(node.type ?? ''),
      mediaKind: typeof data.mediaKind === 'string' ? data.mediaKind : null,
      mimeType: typeof data.mimeType === 'string' ? data.mimeType : null,
    })
  ) {
    return
  }
  const url = String(data.url ?? '').trim()
  if (!url) return
  const targetId = canvasEditor.imageTarget?.nodeId
  if (canvasEditor.refineBusy && targetId && targetId !== node.id) return
  selectOnlyNode(node.id)
  seedRefineIfNeeded(node)
  const fresh = findNodeById(node.id)
  const nextData = (fresh?.data ?? data) as Record<string, unknown>
  canvasEditor.openImageEditor({
    nodeId: node.id,
    url: String(nextData.url ?? url),
    prompt: typeof nextData.prompt === 'string' ? nextData.prompt : undefined,
  })
  closeInspector()
  agentRailRef.value?.closePanel()
  void nextTick(async () => {
    await vueFlowRef.value?.fitView({
      nodes: [node.id],
      padding: 0.38,
      duration: 320,
      maxZoom: 1.2,
    })
  })
}

function openRefineForSelected() {
  openRefineForNode(editorNode.value)
}

function layoutGridSliceChildren(source: EditableFlowNode, childIds: string[], cols: number) {
  const { w: sourceW } = getNodeSize(source as FlowNode)
  const origin = {
    x: source.position.x + sourceW + GRID_SLICE_LAYOUT_GAP,
    y: source.position.y,
  }
  const sizes = childIds.map((id) => {
    const child = findNodeById(id)
    return child ? getNodeSize(child as FlowNode) : { w: 0, h: 0 }
  })
  const positions = layoutSliceChildPositions(origin, sizes, cols)
  childIds.forEach((id, i) => {
    const child = findNodeById(id)
    if (!child) return
    child.position = positions[i]!
  })
}

function selectNodeIds(ids: string[]) {
  if (ids.length === 0) return
  if (ids.length === 1) {
    selectOnlyNode(ids[0])
    return
  }
  pendingExclusiveSelectId = null
  const set = new Set(ids)
  nodes.value = nodes.value.map((node) => {
    const selected = set.has(node.id)
    return node.selected === selected ? node : { ...node, selected }
  })
  multiSelectedIds.value = ids
  selectedNodeId.value = ids[0]
}

/** 撤回切分：移除单个切片子节点及其关联边（纯前端状态操作，不调后端） */
function removeSliceChildNode(id: string) {
  if (!findNodeById(id)) return
  nodes.value = nodes.value.filter((entry) => entry.id !== id)
  edges.value = edges.value.filter((edge) => edge.source !== id && edge.target !== id)
  if (multiSelectedIds.value.includes(id)) {
    const rest = multiSelectedIds.value.filter((v) => v !== id)
    multiSelectedIds.value = rest
    if (selectedNodeId.value === id) {
      if (rest.length === 1) selectOnlyNode(rest[0]!)
      else clearSelection()
    }
  }
  persistUserEdit()
}

/** 切分结果提示：无 action 走普通 success，有 action 用 VNode 挂「撤回本次切分」按钮 */
function showSliceResultToast(msg: string, actions?: Array<{ label: string; onClick: () => void }>) {
  if (!actions?.length) {
    ElMessage.success(msg)
    return
  }
  let toast: { close: () => void } | null = null
  toast = ElMessage.success({
    message: h('span', { class: 'grid-slice-toast' }, [
      h('span', null, msg),
      ...actions.map((action) =>
        h(
          'button',
          {
            type: 'button',
            style: {
              marginLeft: '10px',
              padding: '0',
              border: 'none',
              background: 'transparent',
              color: 'var(--el-color-primary)',
              font: 'inherit',
              cursor: 'pointer',
            },
            onClick: () => {
              toast?.close()
              action.onClick()
            },
          },
          action.label,
        ),
      ),
    ]),
    duration: 6000,
    showClose: true,
  })
}

async function executeGridSlice(node: EditableFlowNode, cols: number, rows: number) {
  const data = (node.data ?? {}) as Record<string, unknown>
  const sourceUrl = String(data.url ?? '').trim()
  if (!sourceUrl || gridSliceBusy.value) return

  gridSliceBusy.value = true
  const dims = clampGridDims(cols, rows)
  try {
    const result = await runGridSlice({
      sourceUrl,
      cols: dims.cols,
      rows: dims.rows,
      sessionId: sessionId.value,
      sourceNodeId: node.id,
      getSourceNode: () => findNodeById(node.id) ?? node,
      addNode: (type, childData, opts) =>
        addNode(
          type,
          {
            prompt: '',
            imageModel: getProviderConfig('image').model,
            ...childData,
          },
          opts,
        ),
      addEdge,
      layoutChildren: (childIds) => layoutGridSliceChildren(node, childIds, dims.cols),
      getNode: (id) => findNodeById(id) ?? undefined,
      removeNode: removeSliceChildNode,
      notify: showSliceResultToast,
    })
    selectNodeIds(result.nodeIds)
    void persistUserEditAsync()
    return result
  } catch (err) {
    ElMessage.error(apiErrorMessage(err, '宫格裁剪失败'))
    return null
  } finally {
    gridSliceBusy.value = false
  }
}

async function handleGridSliceSlice(cols: number, rows: number) {
  const node = selectionGridSliceNode.value
  if (!node || gridSliceEntryDisabled.value) return
  await executeGridSlice(node, cols, rows)
}

function closeGridSliceWorkbench() {
  if (gridSliceBusy.value) return
  gridSlicePanelNodeId.value = null
}

function handleGridSliceOpenCustom() {
  const node = selectionGridSliceNode.value
  if (!node || gridSliceBusy.value || gridSliceEntryDisabled.value) return
  if (refinePanelNode.value || canvasEditor.refineBusy) {
    ElMessage.warning('请先退出精修')
    return
  }
  gridSlicePanelNodeId.value = node.id
}

async function handleGridSliceConfirm(dims: { cols: number; rows: number }) {
  const node = gridSlicePanelNode.value
  if (!node || gridSliceBusy.value) return
  const result = await executeGridSlice(node, dims.cols, dims.rows)
  if (result) closeGridSliceWorkbench()
}

function closeRefineWorkbench() {
  canvasEditor.closeImageEditor()
}

function handleRefineApply(payload: RefineApplyPayload) {
  const nodeId = canvasEditor.imageTarget?.nodeId
  const node = nodeId && findNodeById(nodeId)
  if (!node) {
    ElMessage.warning('原图节点已不存在')
    return
  }
  const appliedKey = payload.recordId ?? `matting:${payload.url}`
  const res = applyRefineAsChild({
    sourceNode: { id: node.id, position: { ...node.position } },
    result: {
      url: payload.url,
      prompt: payload.prompt,
      recordId: payload.recordId,
      appliedKey,
      nodeSize: payload.metadata?.outpaintTo
        ? containFitSize({ width: 280, height: 280 }, payload.metadata.outpaintTo)
        : undefined,
    },
    addNode: (type, data, opts) =>
      addNode(type, { prompt: '', imageModel: getProviderConfig('image').model, ...data } as never, opts),
    addEdge,
    findAppliedNode: (key) => nodes.value.find((n) => (n.data as Record<string, unknown>)?.appliedKey === key),
  })
  selectNodeIds([res.nodeId])
  void persistUserEditAsync()
  if (res.created) ElMessage.success('已应用到画布（下游新节点）')
  else ElMessage.info('该结果已应用过，已为你定位节点')
}

/**
 * 浮层一键抠图（Task 9）：不进精修模式，直接调 studioApi.mattingImage 生成下游节点，
 * 注入/幂等/toast 语义与 handleRefineApply（applyRefineAsChild）完全一致。
 * 503 → 服务未启用；502/其余 → 服务暂时不可用（文案同精修面板 Task 7）。
 */
async function handleFloatingMatting(node: EditableFlowNode) {
  const data = (node.data ?? {}) as Record<string, unknown>
  const imageUrl = String(data.url ?? '').trim()
  if (!imageUrl || mattingBusy.value) return
  mattingBusy.value = true
  try {
    const { data: res } = await studioApi.mattingImage({ imageUrl })
    const resultUrl = res.data.url
    const applied = applyRefineAsChild({
      sourceNode: { id: node.id, position: { ...node.position } },
      result: {
        url: resultUrl,
        prompt: '抠图',
        appliedKey: `matting:${resultUrl}`,
      },
      addNode: (type, childData, opts) =>
        addNode(type, { prompt: '', imageModel: getProviderConfig('image').model, ...childData } as never, opts),
      addEdge,
      findAppliedNode: (key) => nodes.value.find((n) => (n.data as Record<string, unknown>)?.appliedKey === key),
    })
    selectNodeIds([applied.nodeId])
    void persistUserEditAsync()
    if (applied.created) ElMessage.success('已应用到画布（下游新节点）')
    else ElMessage.info('该结果已应用过，已为你定位节点')
  } catch (err) {
    const ax = err as { response?: { status?: number; data?: { message?: string } } }
    const status = ax.response?.status
    if (status === 503) ElMessage.warning('抠图服务未启用')
    else if (status === 400)
      // 服务端对 >20MB / >4096px / 不支持格式返回 400，透传 message 而非「暂时不可用」。
      ElMessage.warning(ax.response?.data?.message || '图片不符合要求（限 20MB / 4096px）')
    else ElMessage.warning('抠图服务暂时不可用')
  } finally {
    mattingBusy.value = false
  }
}

// —— 节点直裁（浮层「裁剪」→ 节点卡覆盖裁剪层，竞品交互） ——

const nodeCropNode = computed((): EditableFlowNode | null => {
  if (!nodeCropNodeId.value) return null
  const node = findNodeById(nodeCropNodeId.value)
  if (!node || !String((node.data as Record<string, unknown> | undefined)?.url ?? '').trim()) return null
  return node as EditableFlowNode
})

const nodeCropUrl = computed(() => String((nodeCropNode.value?.data as Record<string, unknown> | undefined)?.url ?? ''))

function closeNodeCrop() {
  nodeCropNodeId.value = null
}

function handleFloatingCropStart(node: EditableFlowNode) {
  if (nodeCropBusy.value) return
  if (refinePanelNode.value || gridSlicePanelNode.value) {
    ElMessage.warning('请先退出当前工作台')
    return
  }
  nodeOutpaintNodeId.value = null
  nodeInpaintNodeId.value = null
  nodeElementEditNodeId.value = null
  nodeAnnotateNodeId.value = null
  nodeCropNodeId.value = node.id
}

/**
 * 节点直裁确认：display rect → cover 映射回原图像素 → renderCropBlob(θ=0) →
 * persist → applyRefineAsChild 下游新节点（同抠图/精修应用链路）。
 * appliedKey 用「源节点 + 像素框」做幂等键：同源同框重复裁剪只落一个下游节点。
 */
async function handleNodeCropConfirm(displayRect: { x: number; y: number; width: number; height: number }) {
  const node = nodeCropNode.value
  if (!node || nodeCropBusy.value) return
  const data = (node.data ?? {}) as Record<string, unknown>
  const imageUrl = String(data.url ?? '').trim()
  if (!imageUrl) return
  nodeCropBusy.value = true
  try {
    const img = await loadCropSourceImage(imageUrl)
    const { w, h } = getNodeSize(node as FlowNode)
    const pixelRect = displayRectToPixelRect(displayRect, img.naturalWidth, img.naturalHeight, w, h)
    const blob = await renderCropBlob(img, { rect: pixelRect, rotationDeg: 0 })
    const file = new File([blob], 'crop.png', { type: 'image/png' })
    const fallbackUrl = URL.createObjectURL(file)
    let persisted: string
    try {
      persisted = await persistMediaUrl(file, fallbackUrl)
    } catch (e) {
      URL.revokeObjectURL(fallbackUrl)
      throw e
    }
    if (persisted !== fallbackUrl) URL.revokeObjectURL(fallbackUrl)
    const appliedKey = `crop:${node.id}:${pixelRect.x},${pixelRect.y},${pixelRect.width},${pixelRect.height}`
    const applied = applyRefineAsChild({
      sourceNode: { id: node.id, position: { ...node.position } },
      result: { url: persisted, prompt: '裁剪', appliedKey },
      addNode: (type, childData, opts) =>
        addNode(type, { prompt: '', imageModel: getProviderConfig('image').model, ...childData } as never, opts),
      addEdge,
      findAppliedNode: (key) => nodes.value.find((n) => (n.data as Record<string, unknown>)?.appliedKey === key),
    })
    selectNodeIds([applied.nodeId])
    void persistUserEditAsync()
    closeNodeCrop()
    if (applied.created) ElMessage.success('已裁剪并应用到画布（下游新节点）')
    else ElMessage.info('该裁剪结果已应用过，已为你定位节点')
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : '裁剪失败，请重试'
    ElMessage.error(message)
  } finally {
    nodeCropBusy.value = false
  }
}

// —— 节点直出扩图（浮层「扩图」→ 节点外圈扩图框，轻量复刻竞品） ——

const nodeOutpaintNode = computed((): EditableFlowNode | null => {
  if (!nodeOutpaintNodeId.value) return null
  const node = findNodeById(nodeOutpaintNodeId.value)
  if (!node || !String((node.data as Record<string, unknown> | undefined)?.url ?? '').trim()) return null
  return node as EditableFlowNode
})

const nodeOutpaintUrl = computed(() => String((nodeOutpaintNode.value?.data as Record<string, unknown> | undefined)?.url ?? ''))

function closeNodeOutpaint() {
  if (nodeOutpaintBusy.value) return
  nodeOutpaintNodeId.value = null
}

function handleFloatingOutpaintStart(node: EditableFlowNode) {
  if (nodeOutpaintBusy.value) return
  if (refinePanelNode.value || gridSlicePanelNode.value) {
    ElMessage.warning('请先退出当前工作台')
    return
  }
  nodeCropNodeId.value = null
  nodeInpaintNodeId.value = null
  nodeElementEditNodeId.value = null
  nodeAnnotateNodeId.value = null
  nodeOutpaintNodeId.value = node.id
}

/** 共用：把 editImage 生成结果落为下游新节点（与 handleRefineApply 同语义，appliedKey = recordId）。 */
function applyGeneratedEditChild(node: EditableFlowNode, result: {
  url: string
  recordId?: string
  prompt: string
  nodeSize?: { width: number; height: number }
  successText: string
}) {
  const applied = applyRefineAsChild({
    sourceNode: { id: node.id, position: { ...node.position } },
    result: {
      url: result.url,
      prompt: result.prompt,
      recordId: result.recordId,
      appliedKey: result.recordId ?? `gen:${result.url}`,
      nodeSize: result.nodeSize,
    },
    addNode: (type, childData, opts) =>
      addNode(type, { prompt: '', imageModel: getProviderConfig('image').model, ...childData } as never, opts),
    addEdge,
    findAppliedNode: (key) => nodes.value.find((n) => (n.data as Record<string, unknown>)?.appliedKey === key),
  })
  selectNodeIds([applied.nodeId])
  void persistUserEditAsync()
  if (applied.created) ElMessage.success(result.successText)
  else ElMessage.info('该结果已应用过，已为你定位节点')
}

/**
 * 节点直出扩图确认：像素矩形（floor 后）→ 合成底图+蒙版两张 PNG → persist →
 * image/edit mode:'outpaint'（size 'auto'，单次一张，prompt 走兜底文案）→ 下游新节点
 * （nodeSize 按 outpaintTo contain-fit，与精修应用链路一致）。
 */
async function handleNodeOutpaintConfirm(pixelRect: OutpaintRect) {
  const node = nodeOutpaintNode.value
  if (!node || nodeOutpaintBusy.value) return
  const imageUrl = nodeOutpaintUrl.value
  if (!imageUrl) return
  nodeOutpaintBusy.value = true
  try {
    const img = await loadCropSourceImage(imageUrl)
    const base = { width: img.naturalWidth, height: img.naturalHeight }
    if (!hasOutpaintExtension(base, pixelRect)) {
      ElMessage.info('请先拖动手柄向外扩展画布')
      return
    }
    const { baseSpec, maskSpec } = computeOutpaintLayers(base, pixelRect)
    const { baseBlob, maskBlob } = await renderOutpaintPngs(img, { baseSpec, maskSpec })
    const baseFile = new File([baseBlob], 'outpaint-base.png', { type: 'image/png' })
    const maskFile = new File([maskBlob], 'outpaint-mask.png', { type: 'image/png' })
    const baseFallback = URL.createObjectURL(baseFile)
    const maskFallback = URL.createObjectURL(maskFile)
    let persistedBase = baseFallback
    let persistedMask = maskFallback
    try {
      persistedBase = await persistMediaUrl(baseFile, baseFallback)
      persistedMask = await persistMediaUrl(maskFile, maskFallback)
    } finally {
      if (persistedBase !== baseFallback) URL.revokeObjectURL(baseFallback)
      if (persistedMask !== maskFallback) URL.revokeObjectURL(maskFallback)
    }
    const { data } = await studioApi.editImage(
      {
        prompt: OUTPAINT_FALLBACK_PROMPT,
        imageUrl: persistedBase,
        maskUrl: persistedMask,
        model: editModelKey.value,
        size: 'auto',
        mode: 'outpaint',
        outpaintFrom: base,
        outpaintTo: { width: pixelRect.width, height: pixelRect.height },
        nodeId: node.id,
      },
    )
    const url = data.data.url
    if (!url) throw new Error('扩图结果为空')
    applyGeneratedEditChild(node, {
      url,
      recordId: data.data.id,
      prompt: '扩图',
      nodeSize: containFitSize({ width: 280, height: 280 }, { width: pixelRect.width, height: pixelRect.height }),
      successText: '已扩图并应用到画布（下游新节点）',
    })
    nodeOutpaintNodeId.value = null
  } catch (err) {
    const message = apiErrorMessage(err, '扩图失败，请重试')
    ElMessage.error(message)
  } finally {
    nodeOutpaintBusy.value = false
  }
}

// —— 节点直出局部重绘（浮层「局部重绘」→ 蒙版画笔 + prompt 卡，轻量复刻竞品） ——

const nodeInpaintNode = computed((): EditableFlowNode | null => {
  if (!nodeInpaintNodeId.value) return null
  const node = findNodeById(nodeInpaintNodeId.value)
  if (!node || !String((node.data as Record<string, unknown> | undefined)?.url ?? '').trim()) return null
  return node as EditableFlowNode
})

const nodeInpaintUrl = computed(() => String((nodeInpaintNode.value?.data as Record<string, unknown> | undefined)?.url ?? ''))

function closeNodeInpaint() {
  if (nodeInpaintBusy.value) return
  nodeInpaintNodeId.value = null
}

function handleFloatingInpaintStart(node: EditableFlowNode) {
  if (nodeInpaintBusy.value) return
  if (refinePanelNode.value || gridSlicePanelNode.value) {
    ElMessage.warning('请先退出当前工作台')
    return
  }
  nodeCropNodeId.value = null
  nodeOutpaintNodeId.value = null
  nodeElementEditNodeId.value = null
  nodeAnnotateNodeId.value = null
  nodeInpaintNodeId.value = node.id
}

// —— 节点直出元素编辑（多选区局部编辑，复刻竞品） ——

const nodeElementEditNode = computed((): EditableFlowNode | null => {
  if (!nodeElementEditNodeId.value) return null
  const node = findNodeById(nodeElementEditNodeId.value)
  if (!node || !String((node.data as Record<string, unknown> | undefined)?.url ?? '').trim()) return null
  return node as EditableFlowNode
})

const nodeElementEditUrl = computed(() => String((nodeElementEditNode.value?.data as Record<string, unknown> | undefined)?.url ?? ''))

function closeNodeElementEdit() {
  if (nodeElementEditBusy.value) return
  nodeElementEditNodeId.value = null
  nodeAnnotateNodeId.value = null
}

function handleFloatingElementEditStart(node: EditableFlowNode) {
  if (nodeElementEditBusy.value) return
  if (refinePanelNode.value || gridSlicePanelNode.value) {
    ElMessage.warning('请先退出当前工作台')
    return
  }
  nodeCropNodeId.value = null
  nodeOutpaintNodeId.value = null
  nodeInpaintNodeId.value = null
  nodeElementEditNodeId.value = node.id
}

/**
 * 元素编辑确认：多选区合成整图蒙版（paintElementEditMask）→ exportMaskPng → persist →
 * image/edit mode:'inpaint'（combined prompt，size 'auto'，单次一张）→ 下游新节点。
 * 需要原图自然尺寸：由节点 url 加载探测（蒙版按原图分辨率建立）。
 */
async function handleNodeElementEditConfirm(payload: { items: ElementEditItem[] }) {
  const node = nodeElementEditNode.value
  if (!node || nodeElementEditBusy.value) return
  const imageUrl = nodeElementEditUrl.value
  if (!imageUrl) return
  if (!payload.items.length) return
  nodeElementEditBusy.value = true
  try {
    const img = await loadCropSourceImage(imageUrl)
    const naturalW = img.naturalWidth
    const naturalH = img.naturalHeight
    if (!(naturalW > 0) || !(naturalH > 0)) throw new Error('原图加载失败')
    // 节点卡显示尺寸：与 overlay 的 cover 坐标系一致
    const { w: boxW, h: boxH } = getNodeSize(node as FlowNode)
    const maskImages = await preloadElementMaskImages(payload.items)
    const maskCanvas = paintElementEditMask(payload.items, naturalW, naturalH, boxW, boxH, maskImages)
    const blob = await exportMaskPng(maskCanvas)
    const file = new File([blob], 'mask.png', { type: 'image/png' })
    const fallbackUrl = URL.createObjectURL(file)
    let maskUrl: string
    try {
      maskUrl = await persistMediaUrl(file, fallbackUrl)
    } catch (e) {
      URL.revokeObjectURL(fallbackUrl)
      throw e
    }
    if (maskUrl !== fallbackUrl) URL.revokeObjectURL(fallbackUrl)
    const refUrls = payload.items
      .map((it) => it.refUrl?.trim())
      .filter((u): u is string => !!u)
    const { data } = await studioApi.editImage(
      {
        prompt: combineElementEditPrompt(payload.items) || '元素编辑',
        imageUrl,
        maskUrl,
        model: editModelKey.value,
        size: 'auto',
        mode: 'inpaint',
        referenceImageUrls: refUrls.length ? refUrls : undefined,
        nodeId: node.id,
      },
    )
    const url = data.data.url
    if (!url) throw new Error('元素编辑结果为空')
    applyGeneratedEditChild(node, {
      url,
      recordId: data.data.id,
      prompt: payload.items.map((it) => `${it.name} ${it.modify}`.trim()).join('；'),
      successText: `已完成 ${payload.items.length} 处元素编辑（下游新节点）`,
    })
    nodeElementEditNodeId.value = null
    nodeAnnotateNodeId.value = null
  } catch (err) {
    const message = apiErrorMessage(err, '元素编辑失败，请重试')
    ElMessage.error(message)
  } finally {
    nodeElementEditBusy.value = false
  }
}

// —— 节点直出标注（复刻竞品工具条 + 直线箭头/马赛克/水印/签名，2026-09-25） ——

const nodeAnnotateNodeId = ref<string | null>(null)
const nodeAnnotateBusy = ref(false)

const nodeAnnotateNode = computed((): EditableFlowNode | null => {
  if (!nodeAnnotateNodeId.value) return null
  const node = findNodeById(nodeAnnotateNodeId.value)
  if (!node || !String((node.data as Record<string, unknown> | undefined)?.url ?? '').trim()) return null
  return node as EditableFlowNode
})

const nodeAnnotateUrl = computed(() => String((nodeAnnotateNode.value?.data as Record<string, unknown> | undefined)?.url ?? ''))

function handleFloatingAnnotateStart(node: EditableFlowNode) {
  if (nodeAnnotateBusy.value) return
  if (refinePanelNode.value || gridSlicePanelNode.value) {
    ElMessage.warning('请先退出当前工作台')
    return
  }
  nodeCropNodeId.value = null
  nodeOutpaintNodeId.value = null
  nodeInpaintNodeId.value = null
  nodeElementEditNodeId.value = null
  nodeAnnotateNodeId.value = node.id
}

function closeNodeAnnotate() {
  if (nodeAnnotateBusy.value) return
  nodeAnnotateNodeId.value = null
}

/**
 * 标注确认：drawAnnotates 烧录原图（马赛克像素化 + 矢量叠加）→ PNG → persist →
 * 下游新节点（纯本地处理，免费不消耗积分）。
 */
async function handleNodeAnnotateConfirm(payload: { ops: AnnotateShape[] }) {
  const node = nodeAnnotateNode.value
  if (!node || nodeAnnotateBusy.value) return
  const imageUrl = nodeAnnotateUrl.value
  if (!imageUrl) return
  if (!payload.ops.length) return
  nodeAnnotateBusy.value = true
  try {
    const img = await loadCropSourceImage(imageUrl)
    const naturalW = img.naturalWidth
    const naturalH = img.naturalHeight
    if (!(naturalW > 0) || !(naturalH > 0)) throw new Error('原图加载失败')
    const { w: boxW, h: boxH } = getNodeSize(node as FlowNode)
    const canvas = document.createElement('canvas')
    drawAnnotates(canvas, payload.ops, img, naturalW, naturalH, boxW, boxH)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('标注导出失败'))), 'image/png')
    })
    const file = new File([blob], 'annotate.png', { type: 'image/png' })
    const fallbackUrl = URL.createObjectURL(file)
    let url: string
    try {
      url = await persistMediaUrl(file, fallbackUrl)
    } catch (e) {
      URL.revokeObjectURL(fallbackUrl)
      throw e
    }
    if (url !== fallbackUrl) URL.revokeObjectURL(fallbackUrl)
    applyGeneratedEditChild(node, {
      url,
      prompt: '标注',
      successText: '标注已保存（下游新节点，免费）',
    })
    nodeAnnotateNodeId.value = null
  } catch (err) {
    const message = apiErrorMessage(err, '标注保存失败，请重试')
    ElMessage.error(message)
  } finally {
    nodeAnnotateBusy.value = false
  }
}

/**
 * 节点直出局部重绘确认：蒙版 canvas → exportMaskPng → persist →
 * image/edit mode:'edit'（size 'auto'，单次一张）→ 下游新节点。
 */
async function handleNodeInpaintConfirm(payload: { prompt: string; maskCanvas: HTMLCanvasElement; refUrls?: string[] }) {
  const node = nodeInpaintNode.value
  if (!node || nodeInpaintBusy.value) return
  const imageUrl = nodeInpaintUrl.value
  if (!imageUrl) return
  nodeInpaintBusy.value = true
  try {
    const blob = await exportMaskPng(payload.maskCanvas)
    const file = new File([blob], 'mask.png', { type: 'image/png' })
    const fallbackUrl = URL.createObjectURL(file)
    let maskUrl: string
    try {
      maskUrl = await persistMediaUrl(file, fallbackUrl)
    } catch (e) {
      URL.revokeObjectURL(fallbackUrl)
      throw e
    }
    if (maskUrl !== fallbackUrl) URL.revokeObjectURL(fallbackUrl)
    const { data } = await studioApi.editImage(
      {
        prompt: payload.prompt,
        imageUrl,
        maskUrl,
        model: editModelKey.value,
        size: 'auto',
        mode: 'inpaint',
        referenceImageUrls: payload.refUrls?.length ? payload.refUrls : undefined,
        nodeId: node.id,
      },
    )
    const url = data.data.url
    if (!url) throw new Error('重绘结果为空')
    applyGeneratedEditChild(node, {
      url,
      recordId: data.data.id,
      prompt: payload.prompt,
      successText: '已重绘并应用到画布（下游新节点）',
    })
    nodeInpaintNodeId.value = null
  } catch (err) {
    const message = apiErrorMessage(err, '局部重绘失败，请重试')
    ElMessage.error(message)
  } finally {
    nodeInpaintBusy.value = false
  }
}

function handleAgentOpenImageEditor(nodeId: string) {
  const url = String((findNodeById(nodeId)?.data as Record<string, unknown> | undefined)?.url ?? '').trim()
  if (!url) return
  openRefineForNode(findNodeById(nodeId))
}

watch(selectedNodeId, (id) => {
  applyRefineSelectionDecision(id)
})

// 生成失败 toast：只监听「转移到 error」的边，不监听快照相等。
// 重试开始（→ generating）即清该节点去重，保证「失败→重试→再失败」第二次也 toast。
// 详情跳转复用既有诊断抽屉（initialTab: 'diagnostic'），与节点角标 ⓘ 同路径。
function openNodeDiagnostic(nodeId: string) {
  const node = nodes.value.find((n) => n.id === nodeId)
  if (!node) return
  const data = node.data ?? {}
  const generationRecordId = typeof data.generationRecordId === 'string' ? data.generationRecordId : undefined
  void openInspector({
    generationRecordId,
    nodeLabel: typeof data.title === 'string' ? data.title : undefined,
    initialTab: 'diagnostic',
  })
}

const { onNodeError: toastNodeFailure, clearNodeDedupe } = useGenerationFailureToast({
  onOpenDetail: (nodeId) => { void openNodeDiagnostic(nodeId) },
})

watch(
  () => nodes.value.map((n) => ({
    id: n.id,
    title: typeof n.data?.title === 'string' ? n.data.title : undefined,
    status: n.data?.status,
    errorMessage: n.data?.errorMessage,
  })),
  (curr, prevByIdArr) => {
    const prevById = new Map((prevByIdArr ?? []).map((p) => [p.id, p]))
    for (const cur of curr) {
      const prev = prevById.get(cur.id)
      // 仅对「已知节点」的状态转移 toast；初次拉取即已是 error 的节点（无前序快照）不冒泡，
      // 避免打开画布时旧失败节点刷出 toast。
      if (prev === undefined) continue
      if (cur.status === 'generating') clearNodeDedupe(cur.id)
      if (shouldToastForFailure(prev, cur)) toastNodeFailure(cur)
    }
  },
  { deep: false },
)

watch(
  () => canvasEditor.imageTarget,
  (target) => {
    if (!target || !gridSlicePanelNodeId.value) return
    canvasEditor.closeImageEditor()
    ElMessage.warning('请先退出宫格裁剪')
  },
)

// 节点直裁/扩图/重绘/元素编辑让位：选中集变化 / 精修打开 → 收掉覆盖层（confirm 成功路径已先行 close）
watch(multiSelectedIds, () => {
  if (nodeCropNodeId.value) closeNodeCrop()
  if (nodeOutpaintNodeId.value) closeNodeOutpaint()
  if (nodeInpaintNodeId.value) closeNodeInpaint()
  if (nodeElementEditNodeId.value) closeNodeElementEdit()
})
watch(
  () => canvasEditor.imageTarget?.nodeId,
  (nodeId) => {
    if (!nodeId) return
    if (nodeCropNodeId.value) closeNodeCrop()
    if (nodeOutpaintNodeId.value) closeNodeOutpaint()
    if (nodeInpaintNodeId.value) closeNodeInpaint()
  },
)

watch(
  () => canvasEditor.imageTarget?.nodeId,
  (nodeId) => {
    if (!nodeId || !CX_IMAGE_EDIT_ENABLED) return
    const node = findNodeById(nodeId)
    if (!node) return
    seedRefineIfNeeded(node)
    if (selectedNodeId.value !== nodeId) selectOnlyNode(nodeId)
  },
)

function patchSelectedNode(patch: Record<string, unknown>) {
  if (!editorNode.value) return
  debouncedNodePatch.patchNode(editorNode.value.id, patch)
}

function handleRemoveRef(ref: NodeRef) {
  const node = editorNode.value
  if (!node) return
  if (ref.sourceKind === 'edge' && ref.edgeId) {
    deleteEdgeById(ref.edgeId)
    return
  }
  const localRefs = ((node.data?.localRefs as LocalRefBinding[]) ?? []).filter(
    (binding) => binding.id !== ref.refId,
  )
  patchSelectedNode({ localRefs })
}

async function handleNodeGenerate() {
  const node = editorNode.value
  if (!node) return
  // Cancel before flush so a second click isn't delayed by pending patches.
  if (isNodeBusy(node.id) || isDockGenerateBusy(node.data?.status)) {
    cancelGeneration(node.id)
    return
  }
  // L1：若本节点正卡在 propose 等待，先显式确认（registry answered）——不依赖 SSOT 时序，
  // 避免「flush 写回 stale draft → runtime 轮询误判取消」（2026-10-06 生产事故）。
  void agentRailRef.value?.confirmProposeWait?.(node.id)
  await debouncedNodePatch.flush()
  const fresh = editorNode.value
  if (!fresh) return
  if (isNodeBusy(fresh.id) || isDockGenerateBusy(fresh.data?.status)) {
    cancelGeneration(fresh.id)
    return
  }
  // RB-D6①：dock 直生路径——本轮侧栏有图但节点无任何 refs（宽判定含上游边）⇒ 二次确认。
  // propose 确认路径 handleAgentGenerateNode 不加（Ruling 5：那是确认动作本身，弹窗双重打断）。
  const agentStore = useAgentStore()
  const freshData = (fresh.data ?? {}) as Record<string, unknown>
  const refCount = resolveNodeRefs({
    targetNodeId: fresh.id,
    targetType: String(fresh.type),
    nodes: nodes.value,
    edges: edges.value,
    localRefs: (freshData.localRefs as LocalRefBinding[]) ?? [],
    refOrder: (freshData.refOrder as string[]) ?? [],
  }).filter((r) => !r.stale).length
  if (
    shouldConfirmDirectGenerateWithoutRefs({
      nodeType: String(fresh.type),
      refCount,
      sidebarImageCount: latestUserSidebarImageCount(agentStore.messages),
    })
  ) {
    try {
      await ElMessageBox.confirm(MISSING_REFS_CONFIRM_MESSAGE, MISSING_REFS_CONFIRM_TITLE, {
        confirmButtonText: '直接生成',
        cancelButtonText: '先绑定参考图',
        type: 'warning',
      })
    } catch {
      return // 用户取消：不生成（Nest RB-D5 门禁仍兜底）
    }
  }
  await generateForNode(fresh)
}

/** Phase 2b/2c.1: agent propose confirm → same path as dock / retry by nodeId. */
async function handleAgentGenerateNode(nodeId: string) {
  const node = nodes.value.find((n) => n.id === nodeId)
  if (!node) return
  // L1：与 dock 生成同一条显式确认路径（画布确认原子入口）
  void agentRailRef.value?.confirmProposeWait?.(nodeId)
  // Phase 2c.1: leave pending_confirm as soon as confirm/dock generate starts.
  if ((node.data as Record<string, unknown> | undefined)?.status === 'pending_confirm') {
    patchNodeData(nodeId, { status: NODE_GENERATION_STATUS.draft })
  }
  await generateForNode(node as EditableFlowNode)
}

/**
 * ADR-0011 T1：节点内联确认面「取消」——AgentSideRail 节点级 decline
 * （POST /answers {decision:'decline'} + clearProposeGeneration → 节点回 draft），
 * 与侧栏琥珀卡取消同源同语义；无匹配等待时安全 no-op（不发错误信号）。
 */
async function handleProposeConfirmCancel(nodeId: string) {
  await agentRailRef.value?.cancelProposeForNode(nodeId)
}

/**
 * ADR-0011 T1/T4：节点内联「编辑」——置**显式编辑意图**并选中该节点：
 * dock 门控放行（用户要改提示词 / 参数），改完仍走 dock 生成按钮确认
 * （同一 confirmProposeWait → /answers 路径，不新造第二套确认语义）。
 */
function handleProposeConfirmEdit(nodeId: string) {
  proposeConfirmEditIntent.value = true
  selectOnlyNode(nodeId)
}

/**
 * L2（2026-10-06）：propose 等待开始 → 本地节点同步成 pending_confirm。
 *
 * 等待期 `update_node{pending_confirm}` 还没随 tool result 下发，本地是 stale draft；
 * 期间任何 saveCanvas（点生成时的 flush / 拖节点 / 改参数 / 别处出图完成）都会用它
 * **整份覆盖** SSOT 的待确认 ⇒ runtime 判「连续两次 draft = 用户取消」。
 * 守卫：只在草稿态同步（见 shouldSyncProposePending），已 in-flight / 终态不动。
 */
// P0-C（2026-10-13 事故 cmv51vwpu0008p801hxaxcf8m）：propose 等待期记录等待节点，
// saveCanvas 载荷对该节点强制声明 pending_confirm（真值），防 stale 全量盖写 SSOT。
// AgentSideRail proposeWaitEnd 时解除；服务端另有 P0-B 状态转移守卫兜底。
const proposeWaitingNodeId = ref<string | null>(null)

function handleProposeWaitStart(nodeId: string) {
  proposeWaitingNodeId.value = nodeId
  const node = nodes.value.find((n) => n.id === nodeId)
  if (!node) return
  if (!shouldSyncProposePending((node.data as Record<string, unknown> | undefined)?.status)) return
  patchNodeData(nodeId, { status: 'pending_confirm' })
}

/** Phase 2c.1: cancel propose → Nest Jwt clear-propose, then local draft patch. */
async function handleClearProposeGeneration(nodeId: string) {
  try {
    await canvasApi.clearProposeGeneration(sessionId.value, nodeId)
    patchNodeData(nodeId, { status: 'draft' })
  } catch (err) {
    ElMessage.error(apiErrorMessage(err, '取消生成确认失败，请重试'))
  }
}

function getEventCoords(event: MouseEvent | TouchEvent) {
  if ('clientX' in event) {
    return { x: event.clientX, y: event.clientY }
  }
  const touch = event.touches[0] ?? event.changedTouches[0]
  return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 }
}

function findNodeById(id: string) {
  for (const node of nodes.value) {
    if (node.id === id) return node
  }
  return null
}

/** 选中条「下载」与右键「下载图片」共用：从节点取 url 触发浏览器下载 */
function downloadNodeImage(nodeId: string) {
  const node = findNodeById(nodeId)
  const data = (node?.data ?? {}) as Record<string, unknown>
  const url = String(data.url ?? '').trim()
  if (url) {
    const label = data.label ?? data.prompt
    void downloadMediaFile(
      resolveMediaUrl(url),
      mediaDownloadName(url, 'image', label === undefined ? undefined : String(label)),
      { sessionId: sessionId.value },
    )
  }
}

/** 选中条「存库」与右键「存入资产库」共用：把节点媒体存进全局资产库 */
function saveNodeAsset(nodeId: string) {
  const node = findNodeById(nodeId)
  const data = (node?.data ?? {}) as Record<string, unknown>
  const url = String(data.url ?? '').trim()
  if (url) {
    void saveAssetToLibrary({
      kind: 'image',
      url: resolveMediaUrl(url),
      label: typeof data.label === 'string' ? data.label : undefined,
      prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
      sourceNodeId: nodeId,
      sessionId: sessionId.value,
      generationRecordId: typeof data.generationRecordId === 'string' ? data.generationRecordId : undefined,
    })
  }
}

function onNodeContextMenu(event: NodeMouseEvent) {
  event.event.preventDefault()
  const { x, y } = getEventCoords(event.event)
  const data = event.node.data as Record<string, unknown> | undefined
  contextMenu.value = {
    x,
    y,
    nodeId: event.node.id,
    nodeType: String(event.node.type),
    hasUrl: Boolean(String(data?.url ?? '').trim()),
    mediaKind: typeof data?.mediaKind === 'string' ? data.mediaKind : undefined,
    mimeType: typeof data?.mimeType === 'string' ? data.mimeType : undefined,
  }
}

function onPaneContextMenu(event: MouseEvent | TouchEvent) {
  event.preventDefault()
  const { x, y } = getEventCoords(event)
  // Blank canvas: open node picker directly (no intermediate menu / upload-media)
  blankNodePicker.value = { x, y }
}

function closeContextMenu() {
  contextMenu.value = null
}

function handleAddToAgentRefs(sourceIds?: string[]) {
  const ids = sourceIds?.length
    ? sourceIds
    : multiSelectedIds.value.length
      ? multiSelectedIds.value
      : selectedNodeId.value
        ? [selectedNodeId.value]
        : []
  const focusNodes = ids
    .map((id) => findNodeById(id))
    .filter((node): node is EditableFlowNode => node != null)
    .map((node) => ({
      id: node.id,
      type: node.type,
      data: (node.data ?? {}) as Record<string, unknown>,
    }))
  const result = agentRailRef.value?.addFromCanvasNodes(focusNodes)
  agentRailRef.value?.openPanel()
  if (pickMode.active.value && result?.addedNodeIds?.length) {
    for (const id of result.addedNodeIds) pickMode.markPicked(id)
  }
}

function handleCanvasRefPickToggle() {
  if (pickMode.active.value) {
    pickMode.deactivate()
    return
  }
  // 移动端：◎ 定位锚 = 显式进画布（对话视图下画布隐藏，拾取必须在画布上完成）；
  // 带 composer 同屏态（窗），非页签点入的纯画布
  if (isMobileLayout.value) {
    mobileCanvasView.value = true
    mobileCanvasImm.value = false
    mobileAppTab.value = 'canvas'
  }
  if (!isMobileLayout.value) {
    agentRailRef.value?.openPanel()
  }
  pickMode.activate()
  const ids = multiSelectedIds.value.length
    ? [...multiSelectedIds.value]
    : selectedNodeId.value
      ? [selectedNodeId.value]
      : []
  if (!ids.length) return
  const focusNodes = ids
    .map((id) => findNodeById(id))
    .filter((node): node is EditableFlowNode => node != null)
    .map((node) => ({
      id: node.id,
      type: node.type,
      data: (node.data ?? {}) as Record<string, unknown>,
    }))
  const result = agentRailRef.value?.addFromCanvasNodes(focusNodes)
  if (result?.addedNodeIds?.length) {
    for (const id of result.addedNodeIds) pickMode.markPicked(id)
  }
}

function selectMultipleNodes(ids: string[]) {
  const idSet = new Set(ids)
  nodes.value = nodes.value.map((node) => {
    const selected = idSet.has(node.id)
    return node.selected === selected ? node : { ...node, selected }
  })
  multiSelectedIds.value = ids
  if (ids.length === 1) {
    selectedNodeId.value = ids[0]
  } else {
    clearEditorSelection()
  }
}

function handleDuplicateSelection(
  contextNodeId: string,
  edgeMode: DuplicateEdgeMode,
) {
  const sourceIds = resolveDuplicateSourceIds(
    nodes.value as import('@/utils/duplicateCanvasSubgraph').DuplicateFlowNode[],
    edges.value,
    contextNodeId,
    multiSelectedIds.value,
    edgeMode,
  )
  if (!sourceIds.length) return

  const result = duplicateSubgraph(
    nodes.value as import('@/utils/duplicateCanvasSubgraph').DuplicateFlowNode[],
    edges.value,
    sourceIds,
    { edgeMode },
  )
  if (!result.nodes.length) return

  nodes.value = [...nodes.value, ...(result.nodes as EditableFlowNode[])]
  edges.value = [...edges.value, ...(result.edges as CanvasEdge[])]
  selectMultipleNodes(result.newRootIds.length ? result.newRootIds : result.nodes.map((n) => n.id))
  persistUserEdit()

  const count = result.nodes.length
  if (count > 1) {
    ElMessage.success(`已创建 ${count} 个节点副本`)
  }
}

function handleContextAction(action: string) {
  const menu = contextMenu.value
  contextMenu.value = null
  if (!menu) return

  if (action === 'rename' && menu.nodeId) {
    // 打开行内重命名输入（与 PC dblclick 同一个输入框；D-6）
    renameRequestNodeId.value = menu.nodeId
    return
  }

  if (action === 'multi-select' && menu.nodeId) {
    // 进入多选模式（D-4）：以长按节点为种子
    enterMultiSelectMode(menu.nodeId)
    return
  }

  if (action === 'add-agent-ref') {
    const ids = multiSelectedIds.value.length
      ? [...multiSelectedIds.value]
      : selectedNodeId.value
        ? [selectedNodeId.value]
        : menu.nodeId
          ? [menu.nodeId]
          : []
    handleAddToAgentRefs(ids)
    return
  }

  if (action === 'edit-image' && menu.nodeId) {
    openRefineForNode(findNodeById(menu.nodeId))
    return
  }

  if (action === 'download-image' && menu.nodeId) {
    downloadNodeImage(menu.nodeId)
    return
  }

  if (action === 'save-asset' && menu.nodeId) {
    saveNodeAsset(menu.nodeId)
    return
  }

  if (action === 'duplicate' && menu.nodeId) {
    handleDuplicateSelection(menu.nodeId, 'none')
    return
  }

  if (action === 'duplicate-upstream' && menu.nodeId) {
    handleDuplicateSelection(menu.nodeId, 'upstream')
    return
  }

  if (action === 'delete' && menu.nodeId) {
    // 分组节点 = 解组（留节点）；其余节点真删
    if (isGroupNode(nodes.value.find((n) => n.id === menu.nodeId) as unknown as FlowNode)) {
      handleUngroupSelection(menu.nodeId)
      return
    }
    const toRemove = new Set<string>([menu.nodeId])
    rememberGenerationFieldsBeforeRemove(toRemove)
    nodes.value = nodes.value.filter((entry) => !toRemove.has(entry.id))
    edges.value = edges.value.filter((edge) => !toRemove.has(edge.source) && !toRemove.has(edge.target))
    // 被删节点要从分组里摘掉，否则分组框会指向不存在的节点。
    forgetGroupsForRemovedNodes(toRemove)
    persistUserEdit()
    return
  }
}

function openPublish() {
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  showPublish.value = true
}

async function hydrateCompositionRunGroupFromSession() {
  try {
    const { data } = await api.get<{
      data: { canvasData?: { compositionRunGroup?: CompositionRunGroup } }
    }>(`/sessions/${sessionId.value}`)
    const group = data.data.canvasData?.compositionRunGroup
    if (!group) return
    lastKnownCompositionRunGroup.value = group
    if (!compositionRunGroup.value) compositionRunGroup.value = group
  } catch {
    // demo mode
  }
}

async function saveCanvas() {
  saving.value = true
  try {
    let serverGroup: CompositionRunGroup | undefined
    if (!compositionRunGroup.value && !lastKnownCompositionRunGroup.value) {
      try {
        const { data } = await api.get<{
          data: { canvasData?: { compositionRunGroup?: CompositionRunGroup } }
        }>(`/sessions/${sessionId.value}`)
        serverGroup = data.data.canvasData?.compositionRunGroup
        if (serverGroup) {
          lastKnownCompositionRunGroup.value = serverGroup
          if (!compositionRunGroup.value) compositionRunGroup.value = serverGroup
        }
      } catch {
        // demo mode
      }
    }
    // ⛔ group 节点只在内存里存在：落库前必须 fold —— canvasData.nodes 里
    // 永远不出现 type:'group'，分组以 canvasData.groups 侧车 + 子节点绝对坐标持久化。
    const folded = foldGroups(nodes.value as unknown as FlowNode[])
    const canvasData = flowToCanvasData(
      folded.nodes as unknown as import('@/composables/useCanvasActions').FlowNode[],
      edges.value as unknown as import('@/composables/useCanvasActions').FlowEdge[],
      extrasForCanvasSave({
        current: compositionRunGroup.value,
        lastKnown: lastKnownCompositionRunGroup.value,
        server: serverGroup,
        groups: folded.groups,
      }),
    )
    if (canvasData.compositionRunGroup) {
      lastKnownCompositionRunGroup.value = canvasData.compositionRunGroup
      if (!compositionRunGroup.value) {
        compositionRunGroup.value = canvasData.compositionRunGroup
      }
    }
    // P0-C：propose 等待期，等待节点 status 强制声明真值（整份替换语义下
    // 「剥离」= 删除字段，同样是一次状态变化——强制 pending_confirm 才是不覆盖）。
    forcePendingConfirmInPayload(canvasData, proposeWaitingNodeId.value)
    await api.put(`/sessions/${sessionId.value}`, {
      title: sessionTitle.value,
      canvasData,
    })
    // 只在真正落库成功后清失败位——失败路径（含 demo mode 吞异常）不进这里
    saveFailed.value = false
  } catch {
    // demo mode
    saveFailed.value = true
  } finally {
    saving.value = false
  }
}

const {
  isNodeBusy,
  cancelGeneration,
  generateForNode,
  waitForRunGroupMemberSettled,
  onFallbackPending,
} = useNodeGeneration({
  nodes,
  edges,
  sessionId,
  patchNodeData,
  addNode,
  addEdge,
  saveCanvas,
  requireLogin: () => {
    if (!auth.isLoggedIn) {
      auth.openLogin()
      return false
    }
    return true
  },
  startGenerationPolling: (tasks) => generationPolling.start(tasks),
  stopGenerationPolling: (nodeId) => generationPolling.removeByNodeId(nodeId),
  resolveProviderModels: () => ({
    text: getProviderConfig('text').model,
    image: getProviderConfig('image').model,
    video: getProviderConfig('video').model,
  }),
  requestFallbackConfirm,
  isModelSelectable,
  onInsufficientPoints: () => {
    showMembership.value = true
  },
})

function retryNodeGeneration(nodeId: string, overrides?: CanvasNodeRetryOverrides) {
  const node = nodes.value.find((n) => n.id === nodeId)
  if (!node) return
  const data = node.data ?? {}
  const prompt = String(data.prompt ?? '').trim()
  if (!prompt) {
    patchNodeData(nodeId, {
      status: NODE_GENERATION_STATUS.error,
      errorMessage: '请先填写提示词',
    })
    return
  }
  // S2-3 一键换模型重试：模型覆盖走页面级 patch（patchNodeData + persistUserEdit，
  // 与 CANVAS_NODE_PATCH_KEY 同一通路）——禁 updateNodeData 直写内部 store，
  // 否则旧数据轮询/落盘会覆盖掉模型字段（受控画布教训）。
  if (overrides?.modelKey) {
    const modality = modalityForNodeType(String(node.type))
    const field = modality ? modelFieldForModality(modality) : null
    if (field) {
      // 模型换新后旧失败诊断已过时，一并清掉 errorMessage/errorCode
      patchNodeMediaById(nodeId, { [field]: overrides.modelKey, errorMessage: null, errorCode: null })
    }
  }
  patchNodeData(nodeId, { errorMessage: null })
  return generateForNode(node as EditableFlowNode)
}

provide(CANVAS_NODE_CANCEL_KEY, (id) => cancelGeneration(id))
provide(CANVAS_NODE_RETRY_KEY, (id, overrides) => { void retryNodeGeneration(id, overrides) })
// PR1「让 Agent 诊断」：诊断抽屉按钮 → 预填 composer（不自动发送，等用户显式发送）
provide(CANVAS_AGENT_DIAGNOSE_KEY, (info) => {
  const reason = info.errorCode
    ? `${info.userMessage}，错误码：${info.errorCode}`
    : info.userMessage
  const text = `节点「${info.title}」生成失败了（原因：${reason}），帮我诊断并给下一步建议`
  useAgentStore().requestAgentDiagnose(text)
})

const selectedNodeGenerating = computed(() => {
  const node = editorNode.value
  if (!node) return false
  return isNodeBusy(node.id) || isDockGenerateBusy(node.data?.status)
})

onFallbackPendingFromPoll = onFallbackPending

const debouncedNodePatch = useDebouncedNodePatch(
  (id, patch) => patchNodeData(id, patch),
  saveCanvas,
  400,
  {
    onHistoryCommit: () => canvasUndo.commitAfterChange(),
    // 诊断 A2：防抖落盘失败原先静默（unhandled rejection），改动悄悄丢失
    onPersistError: () => ElMessage.error('画布保存失败，本次修改可能未同步，请检查网络后重试'),
  },
)

function nextNodeCounterFromNodes(list: EditableFlowNode[]) {
  let max = 0
  for (const node of list) {
    const match = String(node.id).match(/(\d+)$/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

function hydrateCanvasEdges(
  raw: Array<Pick<CanvasEdge, 'id' | 'source' | 'target'> & Partial<CanvasEdge>>,
  nodeList: EditableFlowNode[],
): CanvasEdge[] {
  const ids = new Set(nodeList.map((node) => node.id))
  const animated = viewportSettings.value.edgeAnimated
  const out: CanvasEdge[] = []
  for (const edge of raw) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    out.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      animated,
    })
  }
  return out
}

async function loadSession() {
  try {
    const { data } = await api.get<{
      data: {
        title: string
        userId?: string
        canvasData?: {
          nodes: Node[]
          edges: Edge[]
          compositionRunGroup?: CompositionRunGroup
          groups?: CanvasGroup[]
        }
      }
    }>(
      `/sessions/${sessionId.value}`,
    )
    sessionTitle.value = data.data.title
    sessionOwnerId.value = data.data.userId ?? null
    if (agentReadOnly.value) {
      ElMessage.warning('此画布属于其他账号，Agent 无法写入画布')
    }
    if (data.data.canvasData?.nodes?.length) {
      // 2026-10-01 修：服务端 canvasData 里可能存在同 id 重复节点（存量数据），
      // 进入前端前先按 id 收敛，避免重复被「原样加载 → saveCanvas 覆盖」再次固化。
      const serverNodes = dedupeNodesById(
        data.data.canvasData.nodes as EditableFlowNode[],
      )
      nodes.value = (nodes.value.length
        ? mergeCanvasNodesFromServer(nodes.value, serverNodes)
        : serverNodes) as EditableFlowNode[]
      edges.value = hydrateCanvasEdges(
        (data.data.canvasData.edges ?? []) as CanvasEdge[],
        nodes.value,
      )
      nodeCounter = nextNodeCounterFromNodes(nodes.value)
      compositionRunGroup.value = data.data.canvasData.compositionRunGroup ?? null
      lastKnownCompositionRunGroup.value = data.data.canvasData.compositionRunGroup ?? null
      // 分组物化：canvasData.groups → vue-flow 父节点（子节点坐标转相对）。
      // 存量脏数据（size 为 0 / childIds 指向已删节点）在这里 fail-open 自愈。
      nodes.value = materializeGroups(
        nodes.value as unknown as FlowNode[],
        data.data.canvasData.groups ?? [],
      ) as EditableFlowNode[]
      reconcileGroups()
      applyGroupDraggable(isMobileLayout.value)
    } else {
      // 空画布就是空画布：不再伪造 prompt-1 占位节点（2026-09-29 拍板，spec 场景 A）。
      // 伪造节点会让用户以为「画布上本来就有东西」，且一旦拖动就会触发 saveCanvas()
      // 把假节点 PUT 覆盖掉服务端真画布（静默数据丢失）。
      nodes.value = []
      edges.value = []
      nodeCounter = 0
      compositionRunGroup.value = null
      lastKnownCompositionRunGroup.value = null
    }
  } catch {
    // 同样不再伪造 prompt-1 占位节点：那是本地假数据，用户一旦拖动就会触发
    // saveCanvas() 把假节点 PUT 覆盖掉服务端真画布（静默数据丢失）。
    // 改为空画布 + 明确报错，让「加载失败」这件事对用户可见。
    nodes.value = []
    edges.value = []
    nodeCounter = 0
    compositionRunGroup.value = null
    lastKnownCompositionRunGroup.value = null
    ElMessage.error('画布加载失败，请刷新重试')
  }
  generationFieldsCache.clear()
  for (const n of nodes.value) {
    rememberGenerationFields(generationFieldsCache, n.id, n.data as Record<string, unknown> | undefined)
  }
  canvasUndo.clear()
  canvasUndo.commitAfterChange()
  startPollingForGeneratingRecords()
  // Fix #2: Reconcile any media nodes whose session canvasData is missing
  // generationRecordId / url — fetch their Studio records and re-apply.
  // This recovers from the bug where Agent `update_node` actions weren't
  // persisted back to session.canvasData in the streamFromRuntime path.
  void reconcileMissingGenerationRecords()
  await consumeFocusNodeQuery()
  await consumeAgentLaunchQuery()
}

/**
 * Reconcile studio generation records with canvas nodes:
 * - attach missing generationRecordId by nodeId
 * - backfill mediaInfo on completed image/video nodes
 */
async function reconcileMissingGenerationRecords() {
  if (!sessionId.value) return
  const mediaTypes = new Set(['image', 'video', 'text', 'prompt', 'audio'])
  const missingRecordId = nodes.value.filter((n) => {
    if (!mediaTypes.has(String(n.type))) return false
    const data = n.data as Record<string, unknown>
    return !data?.generationRecordId
  })
  const missingMediaInfo = nodes.value.filter((n) => {
    if (n.type !== 'image' && n.type !== 'video') return false
    const data = n.data as Record<string, unknown>
    return data?.status === NODE_GENERATION_STATUS.completed && !data?.mediaInfo
  })
  if (!missingRecordId.length && !missingMediaInfo.length) return
  try {
    const { data } = await studioApi.listGenerations({ sessionId: sessionId.value })
    const records = data.data ?? []
    if (!records.length) return
    const byNodeId = new Map<string, GenerationRecord>()
    const byRecordId = new Map<string, GenerationRecord>()
    for (const r of records) {
      if (r.nodeId) byNodeId.set(r.nodeId, r)
      byRecordId.set(r.id, r)
    }
    let patched = 0
    for (const node of missingRecordId) {
      const rec = byNodeId.get(node.id)
      if (!rec) continue
      const patch = buildStudioRecordPatch(node, rec)
      if (!patch) continue
      patchNodeData(node.id, patch)
      patched += 1
    }
    for (const node of missingMediaInfo) {
      const data = node.data as Record<string, unknown>
      const recordId = typeof data.generationRecordId === 'string' ? data.generationRecordId : ''
      const rec = (recordId && byRecordId.get(recordId)) || byNodeId.get(node.id)
      if (!rec || rec.status !== 'completed') continue
      const mediaSummary = buildNodeMediaInfoSummary(rec)
      if (!mediaSummary) continue
      patchNodeData(node.id, { mediaInfo: mediaSummary })
      patched += 1
    }
    if (patched > 0) {
      void saveCanvas()
    }
  } catch {
    // Best-effort: never fail loadSession because of a reconcile miss.
  }
}

function buildStudioRecordPatch(
  _node: EditableFlowNode,
  record: GenerationRecord,
): Record<string, unknown> | null {
  // Skip non-terminal records — polling will catch them.
  if (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'error') {
    return null
  }
  const status =
    record.status === 'completed'
      ? NODE_GENERATION_STATUS.completed
      : record.status === 'failed' || record.status === 'error'
        ? NODE_GENERATION_STATUS.error
        : record.status
  const patch: Record<string, unknown> = {
    status,
    generationRecordId: record.id,
    errorMessage: status === NODE_GENERATION_STATUS.error ? '图像生成未完成或超时' : null,
  }
  if (record.type === 'text') {
    patch.content = parseRecordText(record)
  } else {
    const urls = parseRecordUrls(record)
    if (urls.length) {
      patch.url = urls[0]
      patch.images = urls
    } else if (record.url) {
      patch.url = record.url
    }
    if (record.type === 'video') {
      const lastFrameUrl = parseRecordLastFrameUrl(record)
      if (lastFrameUrl) patch.lastFrameUrl = lastFrameUrl
    }
    if (status === NODE_GENERATION_STATUS.completed && (record.type === 'image' || record.type === 'video')) {
      const mediaSummary = buildNodeMediaInfoSummary(record)
      if (mediaSummary) patch.mediaInfo = mediaSummary
    }
  }
  return patch
}

async function loadSessions() {
  if (!auth.isLoggedIn) return
  try {
    await api.get<{ data: Session[] }>('/sessions')
  } catch {
    // ignore
  }
}

const vueFlowRef = ref<InstanceType<typeof VueFlow> | null>(null)
const canvasAreaRef = ref<HTMLElement | null>(null)


const agentRailRef = ref<InstanceType<typeof AgentSideRail> | null>(null)
const pickMode = useCanvasRefPickMode()
const { isMobileLayout } = useAgentMobileLayout()

// 分组框的 draggable 随布局切换（GC4）：PC 整框可拖是本批的核心诉求；
// 移动端整块框会吃掉平移/长按手势，所以关掉（沿用侧车时代的口径）。
// 加载路径在物化后显式调一次 applyGroupDraggable（materialize 默认 draggable:true）。
watch(isMobileLayout, (mobile) => applyGroupDraggable(mobile))

/**
 * 分组框 8 方向缩放（2026-10-21，与裁剪/扩图同源交互；用户实测诉求「和裁剪、扩图的行为一致」）。
 *
 * 为什么落在这里：nodes 是受控模式的唯一真值，组件不得直写（契约见
 * CanvasNodeGroup 的 CANVAS_GROUP_RESIZE_KEY）。几何全在 `resizeGroupByHandle`
 * （纯函数，由 useCanvasGrouping.native.test.ts 覆盖）：只动该手柄所在边、对边固定、
 * 单边下限 160px、**子节点绝对位置不变**（框变、内容不动）。
 *
 * 落库时机：拖拽过程中**不**写库（每帧一次 PUT 会冲垮 undo 栈和 IO），
 * 只在 `delta === null`（松手）时persist 一次。
 *
 * ⛔ 缩放路径绝不调 fitGroups()：那条通路的语义是「把框贴回子节点包围盒」
 * （拖子节点 / 加载后用），缩放恰恰要脱离包围盒 —— 调了等于立刻撤销用户的缩放。
 *
 * 移动端传 null ⇒ 组件不渲染手柄（与 GC4 同一口径：触屏上整块框的操作权
 * 归平移 / 长按手势）。用 Ref 而不是 provide 一个值：视口运行时会变，
 * provide 值会锁死在 setup 那一刻。
 */
function handleGroupResize(
  groupId: string,
  dir: GroupHandleDir,
  delta: { dx: number; dy: number } | null,
) {
  if (delta) {
    const current = flowNodes.value as unknown as FlowNode[]
    const next = resizeGroupByHandle(current, groupId, dir, delta)
    if (next === current) return
    nodes.value = next as EditableFlowNode[]
    return
  }
  persistUserEdit()
}

const groupResizeFn = ref<CanvasGroupResizeFn | null>(null)
watch(
  isMobileLayout,
  (mobile) => {
    groupResizeFn.value = mobile ? null : handleGroupResize
  },
  { immediate: true },
)
provide(CANVAS_GROUP_RESIZE_KEY, groupResizeFn)
/** P0-1（2026-10-19）：VueFlow 手势配置单一出处——移动端单指平移/双指缩放（断点分流），
 *  PC 逐字保持 [1,2] 中右键平移 + 左键框选。推敲见 useViewportGestures.ts 头部注释。 */
const viewportGestures = useViewportGestures(
  isMobileLayout,
  computed(() => viewportSettings.value.viewLocked),
)
const agentPanelExpanded = ref(false)
/** 移动端画布视图（2026-10-18 信息架构裁决）：默认 false = 对话视图（SSE 对话流 + composer
 *  常驻整页，画布隐藏）。进入画布仅两条路：对话流内点定位（focusNode 系列、handleHistoryLocate）、
 *  composer ◎ 定位锚（引用拾取）；退出 = 拾取结束（watch）或画布上的「返回对话」按钮。
 *  桌面端恒 false，不参与。 */
const mobileCanvasView = ref(false)
/** 纯画布满屏态：传送门 / 页签点入，以及**定位到待确认节点**（ADR-0011 T6，2026-10-20）
 *  = 画布独占（composer/SSE 全隐）；◎ 定位锚与其余定位进入 = 画布 + composer（+SSE）同屏。
 *  两态共用 mobileCanvasView，imm 只决定 composer 是否收起（SSE 在画布视图恒收）。 */
const mobileCanvasImm = ref(false)
/** 移动端应用页签（IA v3，抄 WorkBuddy 壳）：对话 / 画布 / 发现 / 我的。
 *  「门」由画布页签继承（图标=传送门章鱼+光环，固定位零跳变）——切页签即切模式。
 *  窗 A/B（◎ 定位锚 / SSE 定位）= 切到画布页签 + composer 同屏（imm=false）。 */
const mobileAppTab = ref<MobileAppTab>('chat')

function onMobileTabChange(tab: MobileAppTab) {
  mobileAppTab.value = tab
  if (tab === 'canvas') {
    // 页签点画布 = 门语义：纯画布满屏（composer/SSE 收起）
    mobileCanvasView.value = true
    mobileCanvasImm.value = true
  } else if (tab === 'chat') {
    mobileCanvasView.value = false
    mobileCanvasImm.value = false
  }
}

/**
 * PR5（D-9）：移动端壳层桥接——CanvasPage 核心动作以函数集合形式传给 MobileCanvasShell。
 * 壳层是移动端 UI 唯一所有者，通过 props 触发本页逻辑、不回写共享状态
 * （mobileAppTab / mobileCanvasView / mobileCanvasImm 真源仍在 CanvasPage，被
 * AgentSideRail、mobileStudioDockOpen、focusNodeById、pickMode watch 共用）。
 */
const agentRailActions: MobileShellAgentActions = {
  openDrawer: () => agentRailRef.value?.openSessionDrawer(),
  newChat: () => agentRailRef.value?.newAgentSession(),
  openHistory: () => agentRailRef.value?.openThreadHistory(),
  openPanel: () => agentRailRef.value?.openPanel(),
  openAssetLibrary: () => agentRailRef.value?.openAssetLibrary(),
}
const mobileBatchActions: MobileShellBatchActions = {
  done: exitMultiSelectMode,
  generate: handleSelectionBatchGenerate,
  regenerate: handleSelectionBatchRegenerate,
  stop: handleSelectionBatchStop,
  blockedHint: handleSelectionBatchBlocked,
  group: handleGroupSelection,
  ungroup: handleUngroupSelection,
  groupColor: handleGroupColorSelection,
  duplicate: handleKeyboardDuplicate,
  duplicateUpstream: handleToolbarDuplicateUpstream,
  addAgentRef: handleAddToAgentRefs,
  layout: handleLayoutSelection,
  download: handlePackageDownload,
  delete: handleDeleteSelection,
}
/** 移动端 studio dock 的展开态（真源 = DockStudioToolbar 的 tap 通道，向上回报）。
 *  2026-10-21 用户裁决：从 ＋sheet 创建节点**不再自动弹** dock ⇒ 移动端默认折叠
 *  （把手 tap 展开），PC 行为逐字不变。 */
const mobileDockExpanded = ref(false)

/**
 * 画布视图的「窗态」＝ composer 空闲条可见（2026-10-21 真机走查 ①）。
 * 判定与 AgentSideRail 收起 composer 的条件严格一致（is-canvas-view + 非 imm）：
 *  窗态下 composer 与 ＋FAB 同一基线、矩形重合（48=48）⇒ 位移微调盖不干净，
 *  窗态里 FAB 本就不可用（输入会切对话页）⇒ 由 composer 盖住这一带，FAB 不渲染。
 * 纯画布态（页签点入 / 定位到待确认节点）composer 收起 ⇒ ＋FAB 正常露出。
 */
const mobileCanvasComposerVisible = computed(
  () => isMobileLayout.value && mobileCanvasView.value && !mobileCanvasImm.value,
)

/** 移动端画布视图 + studio dock 展开（用户主动 tap 把手）：composer 让位——SSE 对话流收起，
 *  dock 抬高到贴底容器之上（--lnk-agent-dock-h，见 AgentSideRail / DockStudioToolbar）。
 *  ADR-0011（2026-10-19）：pending_confirm 态**不**计入 dock 展开——该态主交互是节点内联
 *  「确认 / 取消」，dock 自动弹会与节点 / 对话只读提示三带叠罗汉互相遮挡。
 *  ⚠️ 2026-10-21：判据从「有选中节点」改为「**实际展开**」——旧判据让 dock 折叠时
 *  composer 也跟着收起（has-studio-dock），画布页底部凭空少一条。 */
const mobileStudioDockOpen = computed(
  () =>
    isMobileLayout.value &&
    mobileCanvasView.value &&
    mobileDockExpanded.value &&
    !dockGatedByPendingConfirm.value &&
    !refinePanelNode.value &&
    !gridSlicePanelNode.value,
)
function onAgentExpandedChange(expanded: boolean) {
  agentPanelExpanded.value = expanded
}

function canOpenAgentPanel(): boolean {
  const d = decideAgentOpenWhileRefine({
    refineOpen: Boolean(canvasEditor.imageTarget),
    refineBusy: canvasEditor.refineBusy,
  })
  if (d === 'block') {
    ElMessage.warning('精修进行中，请先取消')
    return false
  }
  if (d === 'dismiss-refine') canvasEditor.closeImageEditor()
  return true
}

watch(
  () => pickMode.active.value,
  (active, prev) => {
    if (!prev && active) {
      // 进入拾取：清空画布既有选中（handleCanvasRefPickToggle 已同步完成「预加入引用」），
      // studio dock / 工具行随选中消失，拾取态 = 纯净点选。
      clearSelection()
      multiSelectedIds.value = []
      pendingExclusiveSelectId = null
    }
    if (prev && !active && isMobileLayout.value) {
      // 引用拾取结束 ⇒ 回到对话页签（composer 面板随贴底容器回归）
      mobileCanvasView.value = false
      mobileCanvasImm.value = false
      mobileAppTab.value = 'chat'
      nextTick(() => agentRailRef.value?.openPanel())
    }
  },
)

const pickRejectNodeId = ref<string | null>(null)
let pickModeKeydownHandler: ((event: KeyboardEvent) => void) | null = null

provide(CANVAS_REF_PICK_ACTIVE_KEY, pickMode.active)
provide(CANVAS_REF_PICK_NODE_IDS_KEY, pickMode.pickedNodeIds)
provide(CANVAS_REF_PICK_REJECT_KEY, pickRejectNodeId)

onMounted(() => {
  registerLocateNodeHandler(handleHistoryLocate)
  void loadProviderBootstrap().catch(() => {
    // Dock falls back to catalog defaults until bootstrap succeeds
  })
  loadSession()
  loadSessions()

  const mediaHandlers = setupCanvasMediaHandlers(canvasAreaRef, (file, clientPos) => {
    void ingestMediaFile(file, clientPos)
  })

  const area = canvasAreaRef.value
  if (area) {
    area.addEventListener('dragover', (event) => {
      // 资产库条目拖入画布 / dock-studio 时允许 drop
      if (event.dataTransfer?.types.includes('application/lnkpi-asset')) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        return
      }
      const onDock = (event.target as HTMLElement | null)?.closest('.dock-studio-toolbar')
      if (onDock && event.dataTransfer?.types.includes('Files')) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        return
      }
      mediaHandlers.onDragOver(event)
    })
    area.addEventListener('drop', (event) => {
      const assetRaw = event.dataTransfer?.getData('application/lnkpi-asset')
      if (assetRaw) {
        event.preventDefault()
        try {
          const asset = JSON.parse(assetRaw) as CanvasAssetItem
          // 落在 dock-studio 上 = 作为芯片引用挂到当前编辑节点；落在画布上 = 新建节点
          const onDock = (event.target as HTMLElement | null)?.closest('.dock-studio-toolbar')
          if (onDock) {
            if (!tryApplyAssetToSelectedNode(asset)) {
              ElMessage.warning('当前节点不支持该类型的引用')
            }
            return
          }
          const payload = assetPayloadFromItem(asset)
          if (payload) {
            void createFileNodeAt(payload, { x: event.clientX, y: event.clientY })
          }
        } catch {
          // ignore
        }
        return
      }
      const onDock = (event.target as HTMLElement | null)?.closest('.dock-studio-toolbar')
      const file = event.dataTransfer?.files?.[0]
      if (onDock && file) {
        event.preventDefault()
        void handleDockFileDrop(file)
        return
      }
      void mediaHandlers.onDrop(event)
    })
  }
  window.addEventListener('paste', mediaHandlers.onPaste)

  pickModeKeydownHandler = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && pickMode.active.value) {
      pickMode.deactivate()
    }
  }
  window.addEventListener('keydown', pickModeKeydownHandler)
})

onUnmounted(() => {
  registerLocateNodeHandler(null)
  if (pickModeKeydownHandler) {
    window.removeEventListener('keydown', pickModeKeydownHandler)
  }
})
</script>

<template>
  <div class="relative h-[100dvh] w-full overflow-hidden bg-[var(--neo-bg)]" @click="closeContextMenu">
    <div class="flex h-full min-w-0 overflow-hidden">
      <div
        ref="canvasAreaRef"
        class="relative min-h-0 min-w-0 flex-1"
        :class="{
          'canvas-ref-pick-mode': pickMode.active.value,
          'mobile-canvas-veiled': isMobileLayout && !mobileCanvasView,
        }"
      >
        <!--全屏图视图（2026-07-24 改版）：`?graph=1`（由卡片「新窗口打开」进入）。
             ⭐ **不透明**底色（覆盖层曾用 `/97` + blur，导致透出主画布 —— 用户反馈"背景透明的"）。
             ⭐ 高度用 `absolute inset-0` 铺满画布区，**由父级 flex 决定**，不再写死像素高度。 -->
        <div
          v-if="graphOnly"
          class="absolute inset-0 z-[9000] flex flex-col bg-[var(--neo-bg)]"
          data-testid="node-graph-fullscreen"
        >
          <div class="flex shrink-0 items-center gap-2 border-b border-[var(--neo-border)] px-4 py-2.5">
            <span class="text-[13px] font-medium">{{ sessionGraph?.title || '画布概览' }}</span>
            <span v-if="sessionGraph" class="text-[11px] opacity-60">
              {{ sessionGraph.nodes.length }} 个节点 · {{ sessionGraph.edges.length }} 条连线
            </span>
            <a
              class="ml-auto rounded px-2 py-1 text-[12px] opacity-70 hover:opacity-100"
              :href="`/workflow/${sessionId}`"
            >返回画布</a>
          </div>
          <div class="min-h-0 flex-1">
            <AgentNodeGraph
              v-if="sessionGraph"
              class="h-full"
              full-height
              :body="sessionGraph"
              :title="undefined"
              @focus-node="focusNodeById($event)"
            />
            <div
              v-else
              class="flex h-full items-center justify-center text-[13px] opacity-60"
            >这个会话还没有节点图。回到画布向 agent 提问即可生成。</div>
          </div>
        </div>

        <ClickRippleLayer :container="canvasAreaRef" :theme="canvasTheme" />
        <CanvasRefPickOverlay
          v-if="pickMode.active.value"
          :picked-count="pickMode.pickedCount.value"
          @done="pickMode.deactivate()"
        />
        <CanvasFloatingChrome
          v-if="!canvasChromeHidden && !isMobileLayout"
          :title="sessionTitle"
          :saving="saving"
          @update:title="sessionTitle = $event"
          @save="saveCanvas"
          @publish="openPublish"
          @import-workflow="openWorkflowImportPicker"
          @export-workflow="handleExportPack([], 'full_package')"
        />

        <RefineCanvasBack
          v-if="refinePanelNode"
          class="absolute left-3 top-3 z-[50]"
          :disabled="canvasEditor.refineBusy"
          @back="closeRefineWorkbench"
        />

        <VueFlow
          ref="vueFlowRef"
          :nodes="flowNodes"
          :edges="flowEdges"
          :apply-default="false"
          :node-types="nodeTypes as any"
          :default-viewport="{ zoom: 0.8, x: 0, y: 0 }"
          :min-zoom="0.1"
          :max-zoom="2"
          :nodes-selectable="!viewportSettings.viewLocked && !mobileMultiSelectActive"
          :elements-selectable="!viewportSettings.viewLocked"
          :select-nodes-on-drag="false"
          :selection-key-code="viewportGestures.selectionKeyCode"
          :pan-on-drag="viewportGestures.panOnDrag"
          :pan-on-scroll="viewportGestures.panOnScroll"
          :zoom-on-pinch="viewportGestures.zoomOnPinch"
          :pan-activation-key-code="viewportSettings.viewLocked ? null : 'Space'"
          :zoom-on-scroll="!viewportSettings.viewLocked"
          :nodes-draggable="!viewportSettings.viewLocked"
          :nodes-connectable="!viewportSettings.viewLocked"
          :multi-selection-key-code="['Shift', 'Meta', 'Control'] as any"
          :selection-mode="SelectionMode.Partial"
          :snap-to-grid="false"
          :snap-grid="[viewportSettings.gridGap, viewportSettings.gridGap]"
          :connection-radius="48"
          :delete-key-code="null"
          fit-view-on-init
          class="canvas-flow h-full"
          :style="canvasEdgeStyle"
          @connect="onConnect"
          @connect-start="onConnectStart"
          @connect-end="onConnectEnd"
          @nodes-change="onNodesChange"
          @edges-change="onEdgesChange"
          @selection-end="onSelectionEnd"
          @node-click="onNodeClick"
          @node-drag-start="onNodeDragStart"
          @node-drag-stop="onNodeDragStop"
          @pane-click="onPaneClick"
          @dblclick="onPaneDoubleClick"
          @node-context-menu="onNodeContextMenu"
          @pane-context-menu="onPaneContextMenu"
          @edge-click="onEdgeClick"
        >
          <Background
            v-if="viewportSettings.gridVisible"
            :variant="viewportSettings.gridVariant"
            :gap="viewportSettings.gridGap"
            :size="viewportSettings.gridDotSize"
            :color="effectiveGridColor"
          />

          <!-- 分组不再有 overlay：它是 nodeTypes.group 渲染的普通 vue-flow 节点，
               与其它节点共用选中 / 拖动 / 层级 / 裁剪（见 CanvasNodeGroup.vue）。 -->

          <!-- PC 多选工具条：移动端多选态（D-4）改由 MobileMultiSelectBar 承载，
               过渡期非模式态仍走本组件（与重构前一致） -->
          <MultiSelectToolbarOverlay
            v-if="!isMobileLayout || !mobileMultiSelectActive"
            :selected-ids="toolbarSelectionIds"
            :can-generate-video="multiSelectCanGenerateVideo"
            :can-ungroup="multiSelectCanUngroup"
            :group-color-key="multiSelectGroupColorKey"
            :selection-batch="selectionBatchProp"
            @group="handleGroupSelection"
            @ungroup="handleUngroupSelection"
            @group-color="handleGroupColorSelection"
            @delete="handleDeleteSelection"
            @layout="handleLayoutSelection"
            @generate-video="handleGenerateVideoFromSelection"
            @download="handlePackageDownload"
            @add-agent-ref="handleAddToAgentRefs()"
            @duplicate="handleKeyboardDuplicate"
            @duplicate-upstream="handleToolbarDuplicateUpstream"
            @generate-selection="handleSelectionBatchGenerate"
            @generate-regen="handleSelectionBatchRegenerate"
            @stop-selection="handleSelectionBatchStop"
            @blocked-hint="handleSelectionBatchBlocked"
          />
          <!-- ADR-0011 T1：pending_confirm 节点内联确认面（单一锚定表面）。
               确认 = handleAgentGenerateNode（confirmProposeWait + 生成，与 dock 同路径）；
               取消 = AgentSideRail 节点级 decline（与侧栏同源）；编辑 = 显式意图开 dock。 -->
          <ProposeConfirmOverlay
            v-if="proposeConfirmNode"
            :node="proposeConfirmNode"
            @confirm="handleAgentGenerateNode"
            @cancel="handleProposeConfirmCancel"
            @edit="handleProposeConfirmEdit"
          />
          <!-- 等确认期不报进度（2026-10-20 真机走查）：此刻批量 state 仍是 running，但
               0% 且**不会推进**——真正的进度是「等你点确认生成」（AgentSideRail 的
               propose-wait-hint 已如实说明）。留着卡片有三重害：① 满宽卡片把 ＋FAB 与
               保存状态行横穿在同一底部带；② 「批量生成中 + 0%」与 toast 的「在节点上点
               确认生成」自相矛盾（同一画面两个进度信号）；③ 用户误以为还在跑。
               至多一个待确认节点（propose 阻塞期一次一笔）⇒ 不存在「别的节点仍在跑」。 -->
          <SelectionBatchProgressCard
            v-if="!proposeConfirmNode"
            :state="selectionBatchApi.state.value"
            :regenerate="lastBatchRegenerate"
            :progress="selectionBatchApi.progress.value"
            @stop="handleSelectionBatchStop"
          />
          <NodeCropOverlay
            v-if="nodeCropNode"
            :node="nodeCropNode as FlowNode"
            :url="nodeCropUrl"
            :busy="nodeCropBusy"
            @confirm="handleNodeCropConfirm"
            @cancel="closeNodeCrop"
          />
          <NodeOutpaintOverlay
            v-if="nodeOutpaintNode"
            :node="nodeOutpaintNode as FlowNode"
            :url="nodeOutpaintUrl"
            :busy="nodeOutpaintBusy"
            :model-label="editModelLabel"
            @confirm="handleNodeOutpaintConfirm"
            @cancel="closeNodeOutpaint"
          />
          <NodeInpaintOverlay
            v-if="nodeInpaintNode"
            :node="nodeInpaintNode as FlowNode"
            :url="nodeInpaintUrl"
            :busy="nodeInpaintBusy"
            :model-label="editModelLabel"
            @confirm="handleNodeInpaintConfirm"
            @cancel="closeNodeInpaint"
          />
          <NodeElementEditOverlay
            v-if="nodeElementEditNode"
            :node="nodeElementEditNode as FlowNode"
            :url="nodeElementEditUrl"
            :busy="nodeElementEditBusy"
            :model-label="editModelLabel"
            @confirm="handleNodeElementEditConfirm"
            @cancel="closeNodeElementEdit"
          />

          <AnnotateOverlay
            v-if="nodeAnnotateNode"
            :node="nodeAnnotateNode as FlowNode"
            :url="nodeAnnotateUrl"
            :busy="nodeAnnotateBusy"
            @confirm="handleNodeAnnotateConfirm"
            @cancel="closeNodeAnnotate"
          />

          <MultiSelectConnectOverlay
            :selected-ids="multiSelectedIds"
            @connect-target="handleMultiConnectTarget"
            @connect-blank="handleMultiConnectBlank"
          />

          <BatchConnectPickerLine
            v-if="batchConnectPicker"
            :selected-ids="batchConnectPicker.sourceIds"
            :target-x="batchConnectPicker.x"
            :target-y="batchConnectPicker.y"
          />

          <EdgeScissorsOverlay
            :edge-id="selectedEdgeId"
            :x="selectedEdgePos.x"
            :y="selectedEdgePos.y"
            @delete="deleteEdgeById"
          />

          <ConnectPickerLine
            v-if="connectPicker"
            :source-node-id="connectPicker.sourceNodeId"
            :source-handle-id="connectPicker.sourceHandleId"
            :target-x="connectPicker.x"
            :target-y="connectPicker.y"
          />

          <!-- PC 左下视口工具条：移动端隐藏（由 MobileCanvasTopControls 顶部胶囊接管） -->
          <Panel v-if="!isMobileLayout" position="bottom-left" class="canvas-panel-bottom-left">
            <CanvasBottomLeftControls
              :settings="viewportSettings"
              :nodes="minimapNodeList"
              @update:settings="patchViewportSettings"
              @cycle-minimap="cycleMinimap"
            />
          </Panel>

          <!-- 2026-10-21 用户裁决：移动端视口控件瘦身为单枚 ⤢ 适应画布——
     双指捏合已覆盖缩放、小地图低频（PC CanvasBottomLeftControls 保留全量）。 -->
          <Panel
            v-if="isMobileLayout && mobileAppTab === 'canvas'"
            position="top-right"
            class="canvas-panel-mobile-top"
          >
            <MobileCanvasTopControls />
          </Panel>
        </VueFlow>

        <!-- PR2 空态引导（V-3）：空画布首进画布页签的指引文案；pointer-events-none
             不挡平移/缩放手势。S0 纯画布无底部条，文案切到「切对话页」指引。 -->
        <div
          v-if="isMobileLayout && mobileAppTab === 'canvas' && !nodes.length"
          class="mobile-canvas-empty"
          data-testid="mobile-canvas-empty"
        >
          <p class="mobile-canvas-empty__main">画布还是空的</p>
          <p class="mobile-canvas-empty__sub">
            {{ mobileCanvasImm ? '点左下 ＋ 新建节点；想交给 AI，先切到对话页' : '点 ＋ 新建节点，或点底部条输入' }}
          </p>
        </div>

        <RefineWorkbench
          v-if="refinePanelNode"
          :node-id="refinePanelNode.id"
          :before-url="refineBeforeUrl"
          :url="refineBeforeUrl"
          :session-id="sessionId"
          :generation-record-id="refineGenerationRecordId"
          :width="refineMediaWidth"
          :height="refineMediaHeight"
          @close="closeRefineWorkbench"
          @apply="handleRefineApply"
          @busy="canvasEditor.setRefineBusy"
        />
        <GridSliceWorkbench
          v-if="gridSlicePanelNode"
          :url="gridSliceUrl"
          :image-width="gridSliceMediaWidth"
          :image-height="gridSliceMediaHeight"
          :busy="gridSliceBusy"
          @confirm="handleGridSliceConfirm"
          @close="closeGridSliceWorkbench"
        />
        <DockStudioToolbar
          v-if="!refinePanelNode && !gridSlicePanelNode && !dockGatedByPendingConfirm"
          :collapsed="dockCollapsedByOverlay || isMobileLayout"
          @collapse-change="mobileDockExpanded = $event"
          :node="editorNode"
          :upstream="editorUpstream"
          :refs="selectedRefs"
          :mentions="mentionOptions"
          :generating="selectedNodeGenerating"
          :scale="viewportSettings.bottomToolbarScale"
          :tool-row-visible="!!selectionActionBarNode"
          :grid-slice="Boolean(selectionGridSliceNode)"
          :grid-slice-loading="gridSliceBusy"
          :grid-slice-disabled="gridSliceEntryDisabled"
          :grid-slice-disabled-title="gridSliceDisabledTitle"
          :grid-slice-image="gridSliceImageSize"
          :has-url="Boolean(selectionActionBarNode?.data?.url)"
          :matting-busy="mattingBusy"
          @patch="patchSelectedNode"
          @remove-ref="handleRemoveRef"
          @generate="handleNodeGenerate"
          @continue-shot="handleContinueShot"
          @close="onPaneClick"
          @refine="openRefineForSelected"
          @edit="openRefineForSelected"
          @matting="editorNode && handleFloatingMatting(editorNode)"
          @crop="editorNode && handleFloatingCropStart(editorNode)"
          @outpaint="editorNode && handleFloatingOutpaintStart(editorNode)"
          @inpaint="editorNode && handleFloatingInpaintStart(editorNode)"
          @element-edit="editorNode && handleFloatingElementEditStart(editorNode)"
          @annotate="editorNode && handleFloatingAnnotateStart(editorNode)"
          @slice="handleGridSliceSlice"
          @open-custom="handleGridSliceOpenCustom"
          @download="editorNode && downloadNodeImage(editorNode.id)"
          @save-asset="editorNode && saveNodeAsset(editorNode.id)"
        />

        <DockNoticeLayer />

        <!-- PC 左侧竖轨（D-2）：移动端摘除——hover 唤出/268px 弹出/常驻开关全是
             鼠标遗产；新建收敛为 ＋FAB 全宽 sheet，资产库进 sheet 顶部瓦片，
             任务进顶栏 ⋯ 动态项，模型设置归「我的」页。 -->
        <NodePanelDock
          v-if="!canvasChromeHidden && !isMobileLayout"
          @add="handleDockAdd"
          @open-settings="showModelSettings = true"
          @asset-apply="handleAssetApply"
          @asset-add-to-agent="handleAssetAddToAgent"
          @history-locate="handleHistoryLocate"
          @history-retry="handleHistoryRetry"
        />

        <!-- IA v3：移动端由 MobileTopBar/MobileTabBar 接管全局导航，
             画布内右上角主题/账号簇只属桌面态（低频入口归「我的」页）。 -->
        <div v-if="!canvasChromeHidden && !isMobileLayout" class="pointer-events-none absolute right-3 top-3 z-[50] flex items-center gap-2">
          <!-- 沉浸画布没有 AppHeader，主题入口必须保留在这里；
               实现与 header 共用 `ThemeToggle`，不再内联一份 svg。
               `canvas-theme-toggle` 类名保留：既有样式/选择器依赖它。 -->
          <ThemeToggle
            class="canvas-theme-toggle neo-chrome pointer-events-auto h-9 w-9 rounded-xl text-fg-2 hover:text-fg"
          />
          <CanvasAccountChrome />
        </div>

        <input
          ref="workflowImportInputRef"
          type="file"
          accept=".zip,.json,application/zip,application/json"
          class="hidden"
          @change="onWorkflowImportSelected"
        >

        <ConnectNodePicker
          v-if="batchConnectPicker"
          :x="batchConnectPicker.x"
          :y="batchConnectPicker.y"
          :allowed-types="CONNECT_OUT_TARGET_TYPES"
          @select="handleBatchConnectPickerSelect"
          @close="closeBatchConnectPicker"
        />

        <ConnectNodePicker
          v-if="connectPicker"
          :x="connectPicker.x"
          :y="connectPicker.y"
          :allowed-types="CONNECT_OUT_TARGET_TYPES"
          @select="handleConnectPickerSelect"
          @close="closeConnectPicker"
        />

        <ConnectNodePicker
          v-if="blankNodePicker"
          :x="blankNodePicker.x"
          :y="blankNodePicker.y"
          @select="handleBlankPickerSelect"
          @close="closeBlankNodePicker"
        />

      </div>

      <!--ⓘ `?graph=1` 全屏图视图：侧栏与 composer 整页交给图。
           ⚠️⛔ **不能用 `v-if` 隐藏侧栏**（用户实测：新窗口里显示"这个会话还没有节点图"）：
             `loadHistory()` / `bootstrapThread()` 都在 **AgentSideRail 的 onMounted** 里
             ⇒ `v-if` 会让侧栏**根本不挂载** ⇒ 历史数据永不加载 ⇒ 图为空。
           ✅ 用 CSS `hidden`（保持挂载与数据加载，只是不占布局），图表数据照常复原。 -->
      <AgentSideRail
        :class="graphOnly ? 'hidden' : (isMobileLayout && (mobileAppTab === 'discover' || mobileAppTab === 'mine') ? 'hidden' : '')"
        ref="agentRailRef"
        :session-id="sessionId"
        :read-only="agentReadOnly"
        :mobile-canvas-view="mobileCanvasView"
        :mobile-canvas-imm="mobileCanvasImm"
        :mobile-app-tab="mobileAppTab"
        :studio-dock-open="mobileStudioDockOpen"
        :selected-node-id="selectedNodeId"
        :selected-node-ids="multiSelectedIds.length ? multiSelectedIds : (selectedNodeId ? [selectedNodeId] : [])"
        :selected-node="selectedNode"
        :canvas-nodes="nodes"
        @canvas-actions="handleAgentActions"
        @turn-complete="handleAgentTurnComplete"
        @focus-node="focusNodeById"
        @focus-all="focusNodesByIds"
        @export-pack="handleExportPack"
        @undo="handleAgentUndo"
        @redo="handleAgentRedo"
        @open-image-editor="handleAgentOpenImageEditor"
        @arrange-nodes="handleArrangeNodes"
        @import-node-graph="handleImportNodeGraph"
        @canvas-ref-pick-toggle="handleCanvasRefPickToggle"
        @session-created="onMobileTabChange('chat')"
        @expanded-change="onAgentExpandedChange"
        @generate-node="handleAgentGenerateNode"
        @clear-propose-generation="handleClearProposeGeneration"
        @propose-wait-start="handleProposeWaitStart"
        @propose-wait-end="proposeWaitingNodeId = null"
        :can-open="canOpenAgentPanel"
      />
    </div>

    <!--ⓘ 移动端应用骨架（IA v3）：顶栏三区 + 底部四页签 + 发现/我的两页。
         fixed 定位组件，挂载在容器外避免被画布 transform 影响避让计算。 -->
    <!-- PR5（D-9）：移动端导航/面板/状态/入口层收敛到 MobileCanvasShell 单一壳层。
         画布世界（VueFlow + 胶囊 + 空态）仍在此页承载；胶囊/空态因依赖 VueFlow 内部
         定位暂留（见 MobileCanvasShell 头部注释与 PR 描述）。 -->
    <MobileCanvasShell
      v-if="isMobileLayout"
      :mobile-app-tab="mobileAppTab"
      :saving="saving"
      :save-failed="saveFailed"
      :has-nodes="!!nodes.length"
      :multi-select-active="mobileMultiSelectActive"
      :multi-select-count="multiSelectedIds.length"
      :selection-batch="selectionBatchProp"
      :multi-select-can-ungroup="multiSelectCanUngroup"
      :multi-select-group-color-key="multiSelectGroupColorKey"
      :session-id="sessionId"
      :canvas-chrome-hidden="canvasChromeHidden"
      :dock-expanded="mobileDockExpanded"
      :composer-visible="mobileCanvasComposerVisible"
      :on-tab-change="onMobileTabChange"
      :on-save="saveCanvas"
      :on-publish="openPublish"
      :on-import-workflow="openWorkflowImportPicker"
      :on-export-pack="handleExportPack"
      :agent-actions="agentRailActions"
      :dock-add="handleDockAdd"
      :asset-apply="handleAssetApply"
      :asset-add-to-agent="handleAssetAddToAgent"
      :open-membership="() => (showMembership = true)"
      :open-model-settings="() => (showModelSettings = true)"
      :history-locate="handleHistoryLocate"
      :history-retry="handleHistoryRetry"
      :batch-actions="mobileBatchActions"
    />

    <MembershipModal v-model="showMembership" />
    <ProviderConfigDialog v-model="showModelSettings" />
    <ByokFallbackConfirmDialog
      v-model="fallbackDialog.open"
      :message="fallbackDialog.message"
      :loading="fallbackDialog.loading"
      @confirm="onFallbackDialogConfirm"
      @cancel="onFallbackDialogCancel"
    />
    <PublishNeoTVDialog
      v-model="showPublish"
      :session-id="sessionId"
      :default-title="sessionTitle"
      @published="loadSessions"
      @locate-node="handlePublishLocateNode"
    />
    <MediaPreviewOverlay />
    <MediaInspectorDrawer />
    <CanvasContextMenu
      v-if="contextMenu"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :node-id="contextMenu.nodeId"
      :node-type="contextMenu.nodeType"
      :node-title="contextMenu.nodeTitle"
      :has-url="contextMenu.hasUrl"
      :media-kind="contextMenu.mediaKind"
      :mime-type="contextMenu.mimeType"
      :mobile="isMobileLayout"
      :multi-select-active="mobileMultiSelectActive"
      :multi-select-selected="
        !!contextMenu.nodeId && multiSelectedIds.includes(contextMenu.nodeId)
      "
      :multi-selected-count="
        contextMenu.nodeId &&
        multiSelectedIds.includes(contextMenu.nodeId) &&
        multiSelectedIds.length > 1
          ? multiSelectedIds.length
          : 1
      "
      @action="handleContextAction"
      @close="closeContextMenu"
    />
  </div>
</template>

<style scoped>
/* PR2 空态引导（V-3）：居中弱提示，pointer-events-none 不挡画布手势 */
.mobile-canvas-empty {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--lnk-space-2);
  padding: 0 var(--lnk-space-8);
  pointer-events: none;
  text-align: center;
}

.mobile-canvas-empty__main {
  font-size: var(--lnk-text-md);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-secondary);
}

.mobile-canvas-empty__sub {
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-muted);
  line-height: var(--lnk-lh-xs);
}

/* 移动端「我的积分 / 我的订阅」二级 pane 外壳（内容由共享面板渲染） */
.mobile-account-pane {
  position: fixed;
  inset: 0;
  width: 100%;
  max-width: 100vw;
  box-sizing: border-box;
  overflow-x: hidden;
  z-index: 90;
  display: flex;
  flex-direction: column;
  background: var(--lnk-surface-canvas);
  padding: calc(var(--lnk-space-4) + env(safe-area-inset-top)) var(--lnk-pad-card)
    calc(var(--lnk-space-6) + env(safe-area-inset-bottom));
  overflow-y: auto;
}
.mobile-account-head {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-3);
  margin-bottom: var(--lnk-space-4);
}
.mobile-account-back {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-secondary);
  flex-shrink: 0;
}
.mobile-account-title {
  margin: 0;
  font-size: var(--lnk-text-lg);
  font-weight: 700;
  color: var(--lnk-text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mobile-account-body {
  flex: 1;
  min-width: 0;
  max-width: 100%;
}
.mobile-account-close {
  margin-left: auto;
  border: none;
  background: none;
  padding: 0 2px;
  font-size: 20px;
  line-height: 1;
  color: var(--lnk-text-muted);
  cursor: pointer;
}

.canvas-flow {
  background: var(--neo-bg);
  transition: background 0.25s ease;
}

:deep(.canvas-panel-bottom-left) {
  margin: 0 0 12px 8px;
  width: auto !important;
  max-width: none !important;
}

/* 移动端顶部视口胶囊：顶栏（z-85 悬浮全屏）正下方让位 */
:deep(.canvas-panel-mobile-top) {
  margin: calc(var(--lnk-topbar-h, 44px) + 10px) 10px 0 0;
  width: auto !important;
  max-width: none !important;
  z-index: 60;
}

:deep(.vue-flow__selection),
:deep(.vue-flow__nodesselection-rect) {
  background: var(--neo-canvas-selection-fill);
  border: 1.25px dashed var(--neo-canvas-selection-border);
  border-radius: 6px;
}

:deep(.vue-flow__node) {
  overflow: visible !important;
}

:deep(.vue-flow__handle.neo-flow-handle) {
  cursor: crosshair;
}

/* ---- 移动端对话视图：画布隐藏但保持挂载（2026-10-18 信息架构裁决）----
 * ⛔ 不用 display:none / v-if：VueFlow 视口测量会失效（同 ?graph=1 的坑），
 * visibility:hidden 保持布局与 ResizeObserver，切回画布视图 fitView 立即可用。 */
.mobile-canvas-veiled {
  visibility: hidden;
}

</style>
