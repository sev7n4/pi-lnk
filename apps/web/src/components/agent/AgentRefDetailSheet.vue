<script setup lang="ts">
/**
 * 移动端侧栏素材详情外壳：触屏没有 hover，点击芯片直接开全宽 bottom sheet。
 * 复用 MobileSheet（遮罩 / 把手 / X / 锁 body 滚动 / 底部拇指区）与
 * AgentRefMediaBody（唯一的四媒体内容渲染），不新造第三套预览。
 *
 * 关闭通道：X / 点遮罩（MobileSheet 自带）；媒体退出即停由 AgentRefMediaBody 负责。
 * ⛔ 不做长按：长按在本仓已被画布节点动作 sheet 占用，会打架。
 */
import { computed } from 'vue'
import type { NodeRef } from '@/composables/useNodeRefs'
import MobileSheet from '@/components/mobile/MobileSheet.vue'
import AgentRefMediaBody from './AgentRefMediaBody.vue'

const props = withDefaults(
  defineProps<{
    refItem: NodeRef
    /** 底部拇指区唯一主动作：composer 芯片「引用 @T1」/ 历史芯片「再次引用 @T1」 */
    actionLabel?: string
  }>(),
  { actionLabel: '' },
)

const emit = defineEmits<{
  close: []
  action: []
}>()

const title = computed(() => `${props.refItem.refKey} · ${props.refItem.label}`)
const MEDIA_LABEL: Record<string, string> = {
  text: '文档',
  image: '图片',
  video: '视频',
  audio: '音频',
}
const subtitle = computed(() => `${MEDIA_LABEL[props.refItem.mediaType] ?? '素材'} · 点击查看内容`)
</script>

<template>
  <MobileSheet :title="title" :subtitle="subtitle" max-height="85vh" @close="emit('close')">
    <AgentRefMediaBody :ref-item="refItem" expanded />
    <template #actions>
      <button
        v-if="actionLabel"
        type="button"
        class="w-full rounded-lg border border-line px-3 py-2.5 text-sm font-medium text-fg hover:bg-overlay/10"
        data-testid="ref-sheet-action"
        @click="emit('action')"
      >{{ actionLabel }}</button>
    </template>
  </MobileSheet>
</template>
