<script setup lang="ts">
import { Handle, Position, useNode } from '@vue-flow/core'
import { computed, inject, nextTick, ref } from 'vue'
import { CANVAS_NODE_RENAME_KEY } from '@/composables/canvasNodeActions'
import { normalizeGroupColorKey } from './groupColors'

const props = defineProps<{
  selected?: boolean
  data: { title?: string; childIds?: string[]; colorKey?: string }
}>()

const { id: nodeId } = useNode()
const renameNode = inject(CANVAS_NODE_RENAME_KEY, null)
const isHovered = ref(false)

const showHandles = computed(() => props.selected || isHovered.value)
const isRenaming = ref(false)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

function startRename() {
  if (!renameNode) return
  isRenaming.value = true
  renameDraft.value = props.data.title || '未命名分组'
  void nextTick(() => renameInputRef.value?.select())
}

function commitRename() {
  if (!renameNode || !isRenaming.value) return
  const title = renameDraft.value.trim()
  if (title) renameNode(nodeId, title)
  isRenaming.value = false
}

/**
 * 分组色卡（2026-10-12 P3）：选中色经单一 CSS 变量 `--neo-group-accent`
 * 注入容器 —— 背景与虚线边都从它 color-mix 派生（派生比例在 neo-node.css）。
 * 默认 neutral（中性灰），不再是品牌紫；非法 key 静默落 neutral
 * （旧分组无 colorKey 天然兼容）。色值本体在 neowow-tokens.css 成对定义。
 */
const groupStyle = computed(() => ({
  '--neo-group-accent': `var(--neo-group-${normalizeGroupColorKey(props.data.colorKey)})`,
}))
</script>

<template>
  <div
    class="group-node-wrapper neo-node-wrapper"
    :class="{ 'is-active': selected, 'show-handles': showHandles }"
    :style="groupStyle"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <!-- 标题外沿条：与图片/视频节点的 .neo-node-external-title 同位同字体
         （top:-32px · 13px/600 · --neo-node-title-color），兼任拖拽把手 -->
    <div class="group-drag-handle" @dblclick.stop="startRename">
      <input
        v-if="isRenaming"
        ref="renameInputRef"
        v-model="renameDraft"
        class="group-rename-input"
        placeholder="分组名称"
        @keydown.enter.stop="commitRename"
        @keydown.esc.stop="isRenaming = false"
        @blur="commitRename"
        @click.stop
        @mousedown.stop
      >
      <template v-else>
        <h4 class="group-title">{{ data.title || '未命名分组' }}</h4>
        <span class="group-meta">{{ data.childIds?.length ?? 0 }} 个节点</span>
      </template>
    </div>
    <div class="group-node-container h-full w-full" />
    <Handle id="target" type="target" :position="Position.Top" class="neo-flow-handle">
      <div class="handle-hitbox" />
      <div class="handle-plus"><div class="handle-plus-inner" /></div>
    </Handle>
    <Handle id="source" type="source" :position="Position.Bottom" class="neo-flow-handle">
      <div class="handle-hitbox" />
      <div class="handle-plus"><div class="handle-plus-inner" /></div>
    </Handle>
  </div>
</template>

<style scoped>
.group-node-wrapper {
  position: relative;
  overflow: visible;
  width: 100%;
  height: 100%;
}

.group-node-container {
  pointer-events: none;
}

/* 标题外沿条：与图片/视频节点同位（neo-node.css .neo-node-external-title 同款定位），
   字体 token 与 .neo-node-title 同源；兼作拖拽把手（dragHandle 选择器不变） */
.group-drag-handle {
  pointer-events: auto;
  cursor: grab;
  position: absolute;
  top: -32px;
  left: 0;
  right: 0;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-height: 26px;
}

.group-drag-handle:active {
  cursor: grabbing;
}

/* hover 提亮即「这里可拖」的暗示，替代旧文案解释 */
.group-drag-handle:hover .group-title {
  color: var(--neo-node-text);
}

.group-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--neo-node-title-color);
  white-space: nowrap;
  transition: color 0.15s ease;
}

.group-meta {
  font-size: 11px;
  color: var(--neo-node-text-muted);
  opacity: 0.75;
}

.group-rename-input {
  width: 100%;
  border: 1px solid var(--neo-border-strong);
  border-radius: 6px;
  background: var(--neo-hover-bg);
  padding: 1px 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--neo-node-text);
  outline: none;
}

.group-rename-input:focus {
  border-color: var(--neo-accent);
}
</style>
