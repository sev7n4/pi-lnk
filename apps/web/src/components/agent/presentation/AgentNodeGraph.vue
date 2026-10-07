<script setup lang="ts">
/**
 * AgentNodeGraph —— 用 Vue Flow 渲染 `node_graph` 结构化载荷（2026-07）。
 *
 * ## 为什么存在
 *
 * 旧路径 `AgentSvgCard` 收的是 pi-runtime **手写SVG 字符串**（717 行 `render-canvas-view.ts`
 * 产出），只能整块贴图：不可拖拽、不可缩放、点不开大图，且在视觉资产生产画布上
 * 只能给出「文件名列表」—— 而**缩略图才是主信息**。
 *
 * 本组件直接渲染 `node_graph`（nodes/edges 结构化数据，位置来自画布 SSOT），
 * 于是节点可以是**图片缩略图**、可以拖动/缩放/点开大图。
 *
 * ## 与 AgentSvgCard 的关系（双写期）
 *
 * 后端 `render_canvas_view` 现在**同时**产出 `svg_card` 与 `node_graph`。
 * 父组件（`AgentSideRail`）按「有 node_graph 就用它、没有才退 svg_card」处理
 * ⇒ 本组件存在即生效；后端哪天停止发 node_graph，会自动回落旧卡片，无需改前端。
 *
 * ⚠️ **只读**：本组件不发任何写端点。拖拽只是本地视觉反馈（用户松手即回弹），
 * 因为画布 SSOT 在前端主画布（`saveCanvas` 整份覆盖），不是这个只读投影。
 */
import { computed } from 'vue'
import { VueFlow, useVueFlow, type Node, type Edge } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { buildNodeGraphHtml } from './node-graph-export'

/**
 * 与后端 `services/pi-runtime/src/tools/types-node-graph.ts` 对齐（**勿单方面改字段名**）。
 *
 * ⭐ **导出**这个类型：调用方（CanvasPage 的展开层、AgentSideRail 的 emit）都引用它，
 * 避免各处自己写一遍形状 ⇒ 字段一改就编译报错，而不是静默不匹配。
 */
export interface GraphNode {
  id: string
  type?: string
  title?: string
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  groupId?: string
  status?: 'idle' | 'running' | 'failed'
}
export interface GraphEdge {
  source: string
  target: string
  label?: string
}
export interface NodeGraphBody {
  title?: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  droppedNodeIds?: string[]
  totalNodeCount?: number
}

/**
 * 载荷的聚合类型（组件 props 的形状）：调用方 emit / ref 统一用它。
 * ⚠️ 单引出这一个，避免各处重写 `{ nodes, edges, title }` 而在某次改字段后静默不匹配。
 */
export interface GraphPayload extends NodeGraphBody {}

const props = defineProps<{
  body: NodeGraphBody
  title?: string
  /** 参与快照文件名（`<slug>-<sessionId前8位>.html`）。 */
  sessionId?: string
  /** 图片节点的缩略图 URL 解析器（由父组件注入，agent 侧栏通常拿不到画布的 blob URL）。 */
  resolveNodeUrl?: (nodeId: string) => string | undefined
}>()

const emit = defineEmits<{
  focusNode: [nodeId: string]
  /** 展开到画布：把节点图铺满**画布区**（侧栏与 composer 保持可用，见 CanvasPage 布局）。 */
  expandToCanvas: []
  /** 导入到画布：建成**结构化节点组**（非位图 —— 位图在画布上不可编辑、agent 也无法理解）。 */
  importToCanvas: []
}>()

const { fitView } = useVueFlow()

/** 视觉语义：类型 → 颜色/图标/尺寸。未知类型走中性色（不编造语义）。 */
const TYPE_STYLE: Record<string, { label: string; icon: string; w: number; h: number }> = {
  image: { label: '图片', icon: '🖼', w: 168, h: 128 },
  video: { label: '视频', icon: '🎬', w: 168, h: 110 },
  audio: { label: '音频', icon: '🎵', w: 168, h: 96 },
  text: { label: '文本', icon: '📝', w: 168, h: 110 },
  table: { label: '表格', icon: '📊', w: 168, h: 110 },
  group: { label: '分组', icon: '🗂', w: 200, h: 140 },
}
const NEUTRAL = { label: '节点', icon: '⬦', w: 150, h: 96 }

function styleOf(t?: string) {
  return (t && TYPE_STYLE[t]) || NEUTRAL
}

/** 无 position 的节点走网格兜底（Vue Flow 要求 position必填）。 */
function fallbackPosition(i: number): { x: number; y: number } {
  const COLS = 4
  const GAP = 200
  return { x: (i % COLS) * GAP, y: Math.floor(i / COLS) * (NEUTRAL.h + 70) }
}

const vueNodes = computed<Node[]>(() =>
  props.body.nodes.map((n, i) => {
    const s = styleOf(n.type)
    return {
      id: n.id,
      // ⚠️ `type` 必须等于下方 slot 名（`#node-agentNode`），否则 slot 不生效
      type: 'agentNode',
      position: n.position ?? fallbackPosition(i),
      width: n.size?.width ?? s.w,
      height: n.size?.height ?? s.h,
      data: { raw: n, style: s, thumb: props.resolveNodeUrl?.(n.id) },
    }
  }),
)

const vueEdges = computed<Edge[]>(() =>
  props.body.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.source,
    target: e.target,
    label: e.label,
    // 层级边（group→member）画成虚线，视觉上弱于显式连线
    animated: false,
  })),
)

/** 层级边：把 groupId 关系也画出来（后端也产出了显式 edges，这里补层级）。 */
const hierarchyEdges = computed<Edge[]>(() =>
  props.body.nodes
    .filter((n) => n.groupId)
    .map((n, i) => ({
      id: `h${i}`,
      source: n.groupId!,
      target: n.id,
      style: { strokeDasharray: '4 3', opacity: 0.45 },
    })),
)

const allEdges = computed(() => [...vueEdges.value, ...hierarchyEdges.value])

/** 分组框：把 group 节点画成背景容器（而不是可点节点）。 */
const groupNodes = computed(() =>
  props.body.nodes
    .filter((n) => props.body.nodes.some((m) => m.groupId === n.id))
    .filter((n) => n.position)
    .map((n) => {
      const s = styleOf(n.type)
      const members = props.body.nodes.filter((m) => m.groupId === n.id && m.position)
      const xs = members.map((m) => m.position!.x)
      const ys = members.map((m) => m.position!.y)
      const minX = Math.min(...xs) - 24
      const minY = Math.min(...ys) - 40
      const maxX = Math.max(...members.map((m) => m.position!.x + (m.size?.width ?? NEUTRAL.w))) + 24
      const maxY = Math.max(...members.map((m) => m.position!.y + (m.size?.height ?? NEUTRAL.h))) + 24
      return {
        id: `grp-${n.id}`,
        // 匹配下方 `#node-agentGroup` slot
        type: 'agentGroup',
        position: { x: minX, y: minY },
        width: maxX - minX,
        height: maxY - minY,
        style: { background: 'rgba(120,120,140,0.07)', border: '1.5px dashed rgba(140,140,170,0.45)', borderRadius: '10px' },
        draggable: false,
        selectable: false,
        zIndex: -1,
        // ⚠️ data 契约与普通节点对齐（都带 style）—— 否则自定义 slot 里读 `data.style.x` 会炸
        data: { label: n.title || n.id, style: s, raw: n },
      } as unknown as Node
    }),
)

const shown = computed(() => props.body.nodes.length)
const dropped = computed(() => props.body.droppedNodeIds ?? [])

/**
 * 「在新窗口打开」：生成独立 HTML 快照并 `window.open`。
 *
 * ⚠️ 用 **Blob + objectURL** 而不是 data: URL —— data: URL 在部分浏览器会被拦，
 *    且长内容会撞 URL 长度上限。
 * ⚠️ `window.open` 可能被**弹窗拦截器**挡（用户点了没反应）⇒ 兜底提示而不是静默。
 *⚠️ 快照**不含缩略图**：载荷里没有图片 URL（见 node-graph-export.ts 文件头）。
 */
function openInNewWindow() {
  const html = buildNodeGraphHtml(
    props.body.nodes as never,
    (props.body.edges ?? []) as never,
    props.title,
  )
  const blob = new Blob([html], { type: "text/html;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, "_blank", "noopener,noreferrer")
  if (!win) {
    // 弹窗被拦 ⇒ 明确告知，并给一个可点的兜底（不静默失败）
    window.alert("浏览器拦截了新窗口。\n请允许本站弹出窗口后重试，或用「导出到画布」先保存。")
    URL.revokeObjectURL(url)
    return
  }
  // 不立即 revoke：新窗口加载需要时间；页面关闭时浏览器会回收
  win.addEventListener?.("load", () => URL.revokeObjectURL(url), { once: true })
}

function onNodeClick(e: { node?: { id?: string } }) {
  const id = e?.node?.id
  // 跳过内部生成的分组框 id（`grp-*`）
  if (id && !id.startsWith('grp-')) emit('focusNode', id)
}

defineExpose({ fitView })
</script>

<template>
  <div
    class="agent-node-graph"
    :data-testid="'agent-node-graph'"
  >
    <header
      v-if="title || shown > 0"
      class="mb-1.5 flex items-center gap-2 text-[11px] opacity-70"
    >
      <b>{{ title || '画布概览' }}</b>
      <span>{{ shown }} 个节点</span>
      <span v-if="allEdges.length">{{ allEdges.length }} 条连线</span>
      <span
        v-if="body.totalNodeCount != null && body.totalNodeCount > shown"
        class="text-[var(--neo-warn,#f59e0b)]"
      >
        仅显示前 {{ shown }} / {{ body.totalNodeCount }}
      </span>
      <span
        v-if="dropped.length"
        class="text-[var(--neo-warn,#f59e0b)]"
      >{{ dropped.length }} 项未显示</span>

      <!-- 🔀 三个动作入口（2026-07-24）。线性排列、图标在前文字在 tooltip：
           三者同属「把图拿出来看/用」这一族，参照 WorkBuddy 的图标组惯例。
           ⚠️ 顺序 = 使用频率：展开到画布（最常用）→ 导入 → 新窗口打开。 -->
      <span class="agent-graph-actions ml-auto flex items-center gap-0.5">
        <button
          type="button"
          class="agent-graph-action"
          title="展开到画布"
          aria-label="展开到画布"
          data-testid="ng-action-expand"
          @click="emit('expandToCanvas')"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M6 2H2v4M10 2h4v4M14 10v4h-4M2 10v4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
        <button
          type="button"
          class="agent-graph-action"
          title="导入到画布"
          aria-label="导入到画布"
          data-testid="ng-action-import"
          @click="emit('importToCanvas')"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M8 2v7m0 0L5.2 6.2M8 9l2.8-2.8M2.5 11v2a1 1 0 001 1h9a1 1 0 001-1v-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="agent-graph-action"
          title="在新窗口打开（快照 / 可分享）"
          aria-label="在新窗口打开"
          data-testid="ng-action-open-window"
          @click="openInNewWindow"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="1.75" y="2.75" width="9.5" height="8.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M5.5 14h8.25a1 1 0 001-1V5.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <path d="M9 7l3.2 3.2M12.2 7v3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </span>
    </header>

    <div
      class="relative h-[320px] w-full overflow-hidden rounded-md border border-[var(--neo-border)]"
    >
      <VueFlow
        :nodes="[...groupNodes, ...vueNodes]"
        :edges="allEdges"
        :min-zoom="0.2"
        :max-zoom="2.5"
        :default-viewport="{ x: 0, y: 0, zoom: 0.8 }"
        :nodes-draggable="false"
        :nodes-connectable="false"
        :elements-selectable="true"
        :zoom-on-double-click="false"
        :pan-on-drag="true"
        fit-view-on-init
        @node-click="onNodeClick"
      >
        <Background :gap="18" :size="1" pattern-color="rgba(140,140,170,0.25)" />
        <Controls :show-interactive="false" />

        <!-- 自定义节点模板：缩略图优先，标题为辅。
             ⚠️ Vue Flow 的 slot 名 = 节点 `type`。我们把 `type` 设为 `'agentNode'`（见上）
             而不是 `'default'`，否则 slot 不生效、只剩一个默认矩形。 -->
        <template #node-agentNode="{ data }">
          <div class="h-full w-full overflow-hidden">
            <div
              v-if="data.thumb"
              class="w-full"
              :style="{ height: 'calc(100% - 34px)' }"
            >
              <img
                :src="data.thumb"
                :alt="data.raw.title || data.raw.id"
                class="h-full w-full object-cover"
                loading="lazy"
              />
            </div>
            <div
              v-else
              class="flex items-center justify-center text-[26px] opacity-45"
              :style="{ height: 'calc(100% - 34px)' }"
            >{{ data.style.icon }}</div>
            <div class="flex h-[34px] items-center gap-1 px-1.5">
              <span class="shrink-0 text-[10px] opacity-60">{{ data.style.icon }}</span>
              <span class="truncate text-[11px] font-medium">
                {{ data.raw.title || data.raw.id }}
              </span>
              <span
                v-if="data.raw.status === 'running'"
                class="ml-auto shrink-0 text-[9px] text-[#f59e0b]"
              >进行中</span>
              <span
                v-else-if="data.raw.status === 'failed'"
                class="ml-auto shrink-0 text-[9px] text-[#ef4444]"
              >失败</span>
            </div>
          </div>
        </template>

        <!-- 分组框：只有一个标题条 -->
        <template #node-agentGroup="{ data }">
          <div class="h-full w-full">
            <div class="px-2 py-0.5 text-[10px] opacity-55">{{ data.label }}</div>
          </div>
        </template>
      </VueFlow>
    </div>
  </div>
</template>

<style scoped>
/* 自定义节点：缩略图优先，标题为辅（视觉资产画布的主信息是图，不是文字）。 */
.agent-node-graph :deep(.vue-flow__node) {
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid var(--neo-border, #2a2a2a);
  background: var(--neo-surface-card, #161616);
  font-size: 11px;
}
.agent-node-graph :deep(.vue-flow__node.selected) {
  border-color: var(--neo-accent, #3b82f6);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.28);
}
.agent-node-graph :deep(.vue-flow__handle) {
  display: none;
}
/* 分组框：只显示标题条，不要交互样式 */
.agent-node-graph :deep(.vue-flow__node[id^='grp-']) {
  border: none;
  background: transparent;
}
.agent-node-graph :deep(.vue-flow__edge-text) {
  font-size: 10px;
}

/* ── 动作图标组（2026-07-24）────────────────────────────────────────────
   三枚图标线性排列、无分隔（同族动作），hover 出tooltip（title 属性）。
   默认低对比（不与卡片内容抢注意力），hover 时提亮 + 出现焦点环。 */
.agent-graph-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: var(--neo-text-muted, #8a8a82);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.agent-graph-action:hover {
  background: var(--neo-surface-card, rgba(0, 0, 0, 0.06));
  color: var(--neo-text, #1c1c1a);
}
/* ⭐ 键盘可达：focus-visible 必须有可见焦点环（图标按钮最容易漏这条）。 */
.agent-graph-action:focus-visible {
  outline: 2px solid var(--neo-accent, #3b82f6);
  outline-offset: 1px;
}
</style>