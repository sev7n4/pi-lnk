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
  /**
   * 选中分组的外框（画布绝对坐标）。
   * 分组不再是节点 ⇒ 工具条不能按节点包围盒定位，改用分组矩形底边居中。
   */
  groupRect?: { position: { x: number; y: number }; size: { width: number; height: number } } | null
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
    // 2026-10-20 分组侧车化：分组 id 不是节点 id，取不到节点包围盒 ⇒ 用分组矩形
    // （画布绝对坐标）定位，挂在分组框底边居中。
    const rect = props.groupRect
    if (rect) {
      const zoom = viewport.value.zoom
      screenPosition.value = {
        x: (rect.position.x + rect.size.width / 2) * zoom + viewport.value.x,
        y: (rect.position.y + rect.size.height) * zoom + viewport.value.y,
      }
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
watch(() => props.groupRect, scheduleUpdate, { deep: true })
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
