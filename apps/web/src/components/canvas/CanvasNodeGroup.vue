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
 * - **8 方向缩放** —— 选中后四角 + 四边中点出现手柄，语义与本项目
 *   裁剪 / 扩图一致（只动该手柄所在边、对边固定、单边下限 160px，见
 *   `resizeGroupByHandle`）。组件只把指针位移按 zoom 换算后交回页面，
 *   ⛔ 不直写 nodes（受控模式下 nodes 是唯一真值）；
 * - **重命名** —— 双击外沿标题条（与图片/视频节点的 `.neo-node-external-title` 同位）；
 * - **背景色 / 解组** —— 选中后由 `MultiSelectToolbar` 承载（色卡 + 解组钮）。
 */
import { computed, inject, nextTick, onUnmounted, ref } from 'vue'
import { useNode, useVueFlow } from '@vue-flow/core'
import {
  CANVAS_GROUP_RESIZE_KEY,
  CANVAS_NODE_RENAME_KEY,
} from '@/composables/canvasNodeActions'
import { GROUP_HANDLE_DIRS, type GroupHandleDir } from '@/composables/useCanvasGrouping'
import { normalizeGroupColorKey } from './groupColors'

const props = defineProps<{
  selected?: boolean
  data: { title?: string; childIds?: string[]; colorKey?: string }
}>()

const { id: nodeId } = useNode()
const { viewport } = useVueFlow()
const renameNode = inject(CANVAS_NODE_RENAME_KEY, null)
/** 注入的是 Ref：视口在运行时会变（移动端↔PC），「移动端无手柄」必须跟着变。 */
const resizeGroupRef = inject(CANVAS_GROUP_RESIZE_KEY, null)
const resizeGroup = computed(() => resizeGroupRef?.value ?? null)
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

// —— 8 方向缩放（2026-10-21）———————————————————————————————
// 手柄只在「选中 + 页面注入了 resizeGroup」时出现。后者是移动端 / 只读态的
// 唯一开关：页面不 provide ⇒ 手柄不渲染（对齐「移动端不拖分组框」的决定）。
//
// ⛔ `resizeGroup.value` 必须显式解包：`resizeGroup` 是 computed **ref 对象**，
// `Boolean(ref)` 恒为 true（对象都是真值）⇒ 会把「没注入」也判成可缩放。
const canResize = computed(() => Boolean(props.selected) && Boolean(resizeGroup.value))

const resizing = ref<{ dir: GroupHandleDir; lastX: number; lastY: number; zoom: number } | null>(null)

function onHandlePointerDown(dir: GroupHandleDir, event: PointerEvent) {
  const apply = resizeGroup.value
  if (!apply) return
  // 手柄在节点盒内：不拦住就会同时触发「整框拖动」+ 画布平移，三个手势打架。
  // stopPropagation 挡事件冒泡；nodrag/nopan 类是 vue-flow d3 filter 的官方开关
  // （`noDragClassName`/`noPanClassName` 默认值，@vue-flow/core 1.48 已核）。
  event.stopPropagation()
  event.preventDefault()
  resizing.value = { dir, lastX: event.clientX, lastY: event.clientY, zoom: viewport.value.zoom }
  window.addEventListener('pointermove', onHandlePointerMove)
  window.addEventListener('pointerup', onHandlePointerUp)
}

function onHandlePointerMove(event: PointerEvent) {
  const state = resizing.value
  const apply = resizeGroup.value
  if (!state || !apply) return
  // 屏幕位移 → 画布坐标位移：缩放 0.5 时拖 100px 只算 50 画布 px，否则框会「跑得比手快」。
  const zoom = state.zoom > 0 ? state.zoom : 1
  const dx = (event.clientX - state.lastX) / zoom
  const dy = (event.clientY - state.lastY) / zoom
  state.lastX = event.clientX
  state.lastY = event.clientY
  if (dx === 0 && dy === 0) return
  apply(nodeId, state.dir, { dx, dy })
}

function onHandlePointerUp() {
  const state = resizing.value
  const apply = resizeGroup.value
  resizing.value = null
  window.removeEventListener('pointermove', onHandlePointerMove)
  window.removeEventListener('pointerup', onHandlePointerUp)
  // delta=null 是「拖完了」的信号 ⇒ 页面此刻才落库（拖拽中逐帧写库会冲垮 undo 栈）
  if (state && apply) apply(nodeId, state.dir, null)
}

onUnmounted(() => {
  window.removeEventListener('pointermove', onHandlePointerMove)
  window.removeEventListener('pointerup', onHandlePointerUp)
})
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

    <!-- 8 手柄（4 角 L 形 + 4 边中点条）：外形与裁剪/扩图手柄同款（NodeOutpaintOverlay），
         交互语义同源：只动该手柄所在边、对边固定。nodrag/nopan 是 vue-flow 的官方
         拖拽/平移豁免类（noDragClassName / noPanClassName 默认值）。 -->
    <template v-if="canResize">
      <button
        v-for="dir in GROUP_HANDLE_DIRS"
        :key="dir"
        type="button"
        class="group-resize-handle nodrag nopan"
        :class="[`group-resize-handle--${dir}`, { 'is-corner': dir.length === 2 }]"
        :data-handle="dir"
        :aria-label="`调整分组框尺寸 ${dir}`"
        @pointerdown="onHandlePointerDown(dir, $event)"
      />
    </template>
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

/* —— 8 手柄（与裁剪/扩图同款：四角 L 形括号 + 四边中点条）——
 * 语义与几何在 useCanvasGrouping.resizeGroupByHandle（只动该边、对边固定）。
 * 颜色全走 --lnk-* 令牌：手柄要同时压在浅/深两主题的分组底色上都能看见，
 * 故用 text-primary（近乎白/近乎黑的反差色）而非品牌紫。 */
.group-resize-handle {
  position: absolute;
  z-index: 2;
  padding: 0;
  border: none;
  background: var(--lnk-text-primary);
  border-radius: 2px;
  touch-action: none;
  cursor: pointer;
}

.group-resize-handle:hover {
  background: var(--lnk-accent);
}

/* 四角：L 形括号（外扩 3px，压在框线上） */
.group-resize-handle.is-corner {
  width: 18px;
  height: 18px;
  background: transparent;
}
.group-resize-handle.is-corner::before,
.group-resize-handle.is-corner::after {
  content: '';
  position: absolute;
  background: var(--lnk-text-primary);
  border-radius: 2px;
}
.group-resize-handle.is-corner:hover::before,
.group-resize-handle.is-corner:hover::after {
  background: var(--lnk-accent);
}
.group-resize-handle.is-corner::before {
  width: 18px;
  height: 3.5px;
}
.group-resize-handle.is-corner::after {
  width: 3.5px;
  height: 18px;
}
.group-resize-handle--nw { left: -3px; top: -3px; cursor: nwse-resize; }
.group-resize-handle--nw::before { left: 0; top: 0; }
.group-resize-handle--nw::after { left: 0; top: 0; }
.group-resize-handle--ne { right: -3px; top: -3px; cursor: nesw-resize; }
.group-resize-handle--ne::before { right: 0; top: 0; }
.group-resize-handle--ne::after { right: 0; top: 0; }
.group-resize-handle--sw { left: -3px; bottom: -3px; cursor: nesw-resize; }
.group-resize-handle--sw::before { left: 0; bottom: 0; }
.group-resize-handle--sw::after { left: 0; bottom: 0; }
.group-resize-handle--se { right: -3px; bottom: -3px; cursor: nwse-resize; }
.group-resize-handle--se::before { right: 0; bottom: 0; }
.group-resize-handle--se::after { right: 0; bottom: 0; }

/* 四边中点：短条 */
.group-resize-handle--n,
.group-resize-handle--s {
  width: 22px;
  height: 5px;
  cursor: ns-resize;
}
.group-resize-handle--n { left: 50%; top: -2.5px; transform: translateX(-50%); }
.group-resize-handle--s { left: 50%; bottom: -2.5px; transform: translateX(-50%); }
.group-resize-handle--w,
.group-resize-handle--e {
  width: 5px;
  height: 22px;
  cursor: ew-resize;
}
.group-resize-handle--w { top: 50%; left: -2.5px; transform: translateY(-50%); }
.group-resize-handle--e { top: 50%; right: -2.5px; transform: translateY(-50%); }
</style>
