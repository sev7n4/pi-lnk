<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { getSelectionBounds } from '@/composables/useCanvasGrouping'
import MultiSelectToolbar from '@/components/canvas/MultiSelectToolbar.vue'

const props = defineProps<{
  selectedIds: string[]
  canGenerateVideo?: boolean
  canUngroup?: boolean
  /** 当前分组色（透传给工具条色点高亮） */
  groupColorKey?: string | null
  selectionBatch?: {
    runCount: number
    regenCount?: number
    state: 'idle' | 'running' | 'stopping' | 'done'
    blocked?: 'pending_confirm' | 'limit_24' | 'missing_prompt'
    blockedCount?: number
    missingCount?: number
  }
}>()

const emit = defineEmits<{
  group: []
  ungroup: []
  delete: []
  layout: [mode: 'along_edges' | 'grid']
  /** SP-B 对齐/分布（六向 + 两轴等距）——透传给 CanvasPage 执行。 */
  align: [payload:
    | { kind: 'align'; alignMode: 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom' }
    | { kind: 'distribute'; axis: 'x' | 'y' }]
  generateVideo: []
  download: [mode: 'full_package' | 'lightweight' | 'media_list_only']
  addAgentRef: []
  duplicate: []
  duplicateUpstream: []
  generateSelection: []
  generateRegen: []
  stopSelection: []
  blockedHint: [reason: 'pending_confirm' | 'limit_24' | 'missing_prompt']
  groupColor: [key: string | null]
}>()

const { viewport, nodes: flowNodes } = useVueFlow()
const screenPosition = ref<{ x: number; y: number } | null>(null)

function updatePosition() {
  if (props.selectedIds.length < 1) {
    screenPosition.value = null
    return
  }
  if (props.canUngroup && props.selectedIds.length === 1) {
    // 2026-10-21 分组回归原生节点形态：分组就是节点（nodeTypes.group），
    // 走常规的节点包围盒定位即可，不再需要「分组外框」这条旁路。
    const bounds = getSelectionBounds(flowNodes.value, props.selectedIds)
    if (!bounds) {
      screenPosition.value = null
      return
    }
    const zoom = viewport.value.zoom
    screenPosition.value = {
      x: bounds.centerX * zoom + viewport.value.x,
      y: bounds.bottomY * zoom + viewport.value.y,
    }
    return
  }
  if (props.selectedIds.length < 2) {
    screenPosition.value = null
    return
  }
  const bounds = getSelectionBounds(flowNodes.value, props.selectedIds)
  if (!bounds) {
    screenPosition.value = null
    return
  }
  const zoom = viewport.value.zoom
  screenPosition.value = {
    x: bounds.centerX * zoom + viewport.value.x,
    y: bounds.bottomY * zoom + viewport.value.y,
  }
}

let raf = 0
function scheduleUpdate() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(updatePosition)
}

watch(() => props.selectedIds, scheduleUpdate, { deep: true })
watch(() => props.canUngroup, scheduleUpdate)
watch(viewport, scheduleUpdate, { deep: true })
watch(flowNodes, scheduleUpdate, { deep: true })

onMounted(() => {
  scheduleUpdate()
  window.addEventListener('resize', scheduleUpdate)
})

onUnmounted(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', scheduleUpdate)
})

const visible = computed(() => props.selectedIds.length >= 2 || !!props.canUngroup)
</script>

<template>
  <MultiSelectToolbar
    v-if="visible"
    :selected-ids="selectedIds"
    :can-generate-video="canGenerateVideo"
    :can-ungroup="canUngroup"
    :group-color-key="groupColorKey"
    :screen-position="screenPosition"
    :selection-batch="selectionBatch"
    @group="emit('group')"
    @ungroup="emit('ungroup')"
    @delete="emit('delete')"
    @layout="emit('layout', $event)"
    @align="emit('align', $event)"
    @generate-video="emit('generateVideo')"
    @download="emit('download', $event)"
    @add-agent-ref="emit('addAgentRef')"
    @duplicate="emit('duplicate')"
    @duplicate-upstream="emit('duplicateUpstream')"
    @generate-selection="emit('generateSelection')"
    @generate-regen="emit('generateRegen')"
    @stop-selection="emit('stopSelection')"
    @blocked-hint="emit('blockedHint', $event)"
    @group-color="emit('groupColor', $event)"
  />
</template>
