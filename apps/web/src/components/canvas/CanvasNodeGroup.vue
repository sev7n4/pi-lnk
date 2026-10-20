<script setup lang="ts">
/**
 * 分组节点（`type:'group'`，2026-10-21 从 pre-#494 恢复并适配新令牌体系）。
 *
 * 为什么它是「节点」而不是 overlay：#494 侧车化后 PC 端只能点左上角 26px 的
 * 小胶囊交互（框体 `pointer-events:none`），违背直接操作原则；且 overlay 手搓的
 * viewport 变换层上挂着 `overflow:hidden`，按元素本地流空间裁剪 ⇒ 拖动时框被
 * 「塞进信封」式淹没。改回 vue-flow 原生父子节点后，选中 / 整框拖动 / 层级 /
 * 命中测试全部由库提供，这两个问题在架构上一起消失。
 *
 * 交互分工：
 * - **整框可拖 / 单击选中** —— vue-flow 默认行为（不要设 `dragHandle`，
 *   一设就退回「只能抓标题条」，正是 #494 之前被抱怨的形态）；
 * - **重命名** —— 双击外沿标题条（与图片/视频节点的 `.neo-node-external-title` 同位）；
 * - **背景色 / 解组** —— 选中后由 `MultiSelectToolbar` 承载（色卡 + 解组钮）。
 */
import { computed, inject, nextTick, ref } from 'vue'
import { useNode } from '@vue-flow/core'
import { CANVAS_NODE_RENAME_KEY } from '@/composables/canvasNodeActions'
import { normalizeGroupColorKey } from './groupColors'

const props = defineProps<{
  selected?: boolean
  data: { title?: string; childIds?: string[]; colorKey?: string }
}>()

const { id: nodeId } = useNode()
const renameNode = inject(CANVAS_NODE_RENAME_KEY, null)
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
 * 分组色卡（2026-10-12 P3）：选中色经单一局部变量 `--group-accent` 注入 ——
 * 背景与虚线边都从它 color-mix 派生（派生比例在 neo-node.css 的
 * `.group-node-container`）。默认 neutral（中性灰），不再是品牌紫；非法 key
 * 静默落 neutral（旧分组无 colorKey 天然兼容）。色值本体在 design-tokens.css
 * 的 `--lnk-group-*`（两主题成对定义），本组件不写任何字面 hex。
 */
const groupStyle = computed(() => ({
  '--group-accent': `var(--lnk-group-${normalizeGroupColorKey(props.data.colorKey)})`,
}))
</script>

<template>
  <div
    class="group-node-wrapper"
    :class="{ 'is-active': selected }"
    :style="groupStyle"
  >
    <!-- 标题外沿条：与图片/视频节点的 .neo-node-external-title 同位同字体
         （top:-32px · 13px/600）。整框可拖，所以它只保留重命名入口。 -->
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
        <span class="group-title-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
            <rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
            <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
            <rect x="13" y="13" width="7.5" height="7.5" rx="2" />
          </svg>
        </span>
        <h4 class="group-title">{{ data.title || '未命名分组' }}</h4>
        <span class="group-meta">{{ data.childIds?.length ?? 0 }} 个节点</span>
      </template>
    </div>
    <div class="group-node-container" />
  </div>
</template>

<style scoped>
/* 整盒可拖：光标形状即「这里能拖」的暗示（不设 dragHandle，整框都是拖拽面） */
.group-node-wrapper {
  position: relative;
  overflow: visible;
  width: 100%;
  height: 100%;
  cursor: grab;
}

.group-node-wrapper:active {
  cursor: grabbing;
}

/* 标题外沿条：与图片/视频节点同位（neo-node.css .neo-node-external-title 同款定位） */
.group-drag-handle {
  pointer-events: auto;
  cursor: pointer;
  position: absolute;
  top: -32px;
  left: 0;
  right: 0;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: var(--lnk-space-2);
  min-height: 26px;
}

/* hover 提亮即「这里可改名」的暗示 */
.group-drag-handle:hover .group-title {
  color: var(--lnk-text-primary);
}

/* 分组图标：标题前的 2×2 网格标——「这是一组」的速识。
   颜色跟随分组背景色（--group-accent 由 wrapper 按 colorKey 注入）。 */
.group-title-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  align-self: center;
  color: var(--group-accent, var(--lnk-group-neutral));
  transition: color var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.group-title-icon svg {
  display: block;
  width: 13px;
  height: 13px;
}

.group-title {
  margin: 0;
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-semibold);
  line-height: var(--lnk-lh-sm);
  color: var(--lnk-text-secondary);
  white-space: nowrap;
  transition: color var(--lnk-duration-fast) var(--lnk-ease-standard);
}

.group-meta {
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
  color: var(--lnk-text-muted);
  opacity: 0.75;
}

.group-rename-input {
  width: 100%;
  border: 1px solid var(--lnk-border-strong);
  border-radius: var(--lnk-radius-sm);
  background: var(--lnk-hover-overlay);
  padding: 1px var(--lnk-space-1);
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
  outline: none;
}

.group-rename-input:focus {
  border-color: var(--lnk-accent);
}
</style>
