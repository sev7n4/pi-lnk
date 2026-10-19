<script setup lang="ts">
/** 移动端「任务」全宽 sheet（2026-10-19 D-2 入口收敛）：任务面板从竖轨移入
 *  顶栏 ⋯ 动态项后的承载容器。面板本体复用 CanvasTaskHistoryPanel（不动），
 *  只换外壳；定位/重试事件原样上抛，由 CanvasPage 既有处理器接管。 */
import MobileSheet from '@/components/mobile/MobileSheet.vue'
import CanvasTaskHistoryPanel from '@/components/canvas/CanvasTaskHistoryPanel.vue'

const emit = defineEmits<{
  locate: [payload: { recordId: string; nodeId?: string | null }]
  retry: [nodeId: string]
  close: []
}>()
</script>

<template>
  <MobileSheet
    title="任务"
    subtitle="生成任务的定位与重试"
    max-height="76vh"
    @close="emit('close')"
  >
    <CanvasTaskHistoryPanel
      @locate="emit('locate', $event)"
      @retry="emit('retry', $event)"
    />
  </MobileSheet>
</template>
