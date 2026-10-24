<script setup lang="ts">
import { computed, ref } from 'vue'
import { CX_IMAGE_EDIT_ENABLED, canOpenRefineForNode } from '@/utils/refineSession'

const props = defineProps<{
  x: number
  y: number
  nodeId?: string
  nodeType?: string
  nodeTitle?: string
  hasUrl?: boolean
  mediaKind?: string
  mimeType?: string
}>()

const emit = defineEmits<{
  action: [action: string, payload?: string]
  close: []
}>()

const visible = ref(true)

const showUpstreamDuplicate = computed(() => Boolean(props.nodeId))

const showEditImage = computed(
  () =>
    CX_IMAGE_EDIT_ENABLED &&
    Boolean(props.hasUrl) &&
    canOpenRefineForNode({
      type: props.nodeType,
      mediaKind: props.mediaKind,
      mimeType: props.mimeType,
    }),
)

const showImageFileActions = computed(
  () => Boolean(props.hasUrl) && props.mediaKind === 'image',
)

function run(action: string, payload?: string) {
  emit('action', action, payload)
  visible.value = false
  emit('close')
}
</script>

<template>
  <!-- PC：右键小浮层（原样保留，行为逐字不变）。
       ⛔ 移动端分支已于 2026-10-24 删除（走查①）：R1-T5 起移动端长按的唯一入口是
       `MobileNodeActionSheet`——CanvasPage 的 `onNodeContextMenu` 在移动端直接
       return。此前的 D-6 移动端 sheet 是 R1 之前的权宜，真机走查发现两个入口会
       同时触发（浏览器长按派发 contextmenu + useLongPress），弹出两张一模一样的
       卡片框（重命名/引用/副本/多选/编辑/删除）。多选累加语义已由页面级
       `enterMultiSelectMode` 承接，动作 sheet 的多选文案随态变化。 -->
  <div
    v-if="visible && nodeId"
    class="neo-popover fixed z-[100] min-w-[160px] rounded-xl py-1"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @click.stop
  >
    <button
      v-if="showEditImage"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs"
      @click="run('edit-image')"
    >
      编辑图像
    </button>

    <button v-if="showImageFileActions" class="neo-popover-item block w-full px-4 py-2 text-left text-xs" @click="run('download-image')">下载图片</button>
    <button v-if="showImageFileActions" class="neo-popover-item block w-full px-4 py-2 text-left text-xs" @click="run('save-asset')">存入资产库</button>

    <button
      v-if="nodeId"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs"
      @click="run('add-agent-ref')"
    >
      加入 Agent 引用
    </button>

    <button
      v-if="nodeId"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs"
      @click="run('duplicate')"
    >
      新建副本
    </button>
    <button
      v-if="showUpstreamDuplicate"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs"
      @click="run('duplicate-upstream')"
    >
      新建副本（含上游）
    </button>
    <button
      v-if="nodeId"
      class="neo-popover-item block w-full px-4 py-2 text-left text-xs !text-danger hover:!text-danger"
      @click="run('delete')"
    >
      删除节点
    </button>
  </div>
</template>
