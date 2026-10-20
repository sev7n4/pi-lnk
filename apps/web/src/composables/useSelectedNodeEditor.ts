import { computed, ref, type Ref } from 'vue'
export { EDITABLE_NODE_TYPES } from '@/constants/dockStudio'

export interface EditableFlowNode {
  id: string
  type?: string
  data?: Record<string, unknown>
  position: { x: number; y: number }
  selected?: boolean
  parentNode?: string
  extent?: 'parent' | [[number, number], [number, number]]
  expandParent?: boolean
  /** 分组 stacking：group=0 / 子节点=1 / 拖拽中临时抬升（见 CanvasPage onNodeDragStart） */
  zIndex?: number
  /**
   * 分组框尺寸（`type:'group'` 专用）：物化时按 CanvasGroup.size 写死，
   * vue-flow 测量前也能撑出正确外框；测量后 dimensions 才是权威值。
   */
  style?: Record<string, string>
  /** 逐节点拖拽开关（移动端关掉分组框拖拽，见 CanvasPage applyGroupDraggable） */
  draggable?: boolean
  selectable?: boolean
  /** vue-flow 测量结果（由库回填，只读） */
  dimensions?: { width?: number; height?: number }
}

export function useSelectedNodeEditor(nodes: Ref<EditableFlowNode[]>) {
  const selectedNodeId = ref<string | null>(null)

  const selectedNode = computed((): EditableFlowNode | null => {
    if (!selectedNodeId.value) return null
    for (const node of nodes.value) {
      if (node.id === selectedNodeId.value) return node
    }
    return null
  })

  function clearEditorSelection() {
    selectedNodeId.value = null
  }

  /** 不可变更新 selected，避免与 applyNodeChanges 抢状态时出现「幽灵多选」 */
  function clearSelection() {
    clearEditorSelection()
    nodes.value = nodes.value.map((node) =>
      node.selected ? { ...node, selected: false } : node,
    )
  }

  function selectNode(id: string | null) {
    selectedNodeId.value = id
    nodes.value = nodes.value.map((node) => {
      const selected = id !== null && node.id === id
      return node.selected === selected ? node : { ...node, selected }
    })
  }

  function patchNodeData(id: string, patch: Record<string, unknown>) {
    nodes.value = nodes.value.map((node) =>
      node.id === id ? { ...node, data: { ...(node.data ?? {}), ...patch } } : node,
    )
  }

  return {
    selectedNodeId,
    selectedNode,
    selectNode,
    clearEditorSelection,
    clearSelection,
    patchNodeData,
  }
}
