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
  /**
   * 铺满父级高度。
   *
   * ⚠️ **必须显式开启**：默认仍走 320px，否则在气泡里会把整条消息撑得很高。
   *   覆盖层/全屏页这些"容器已有确定高度"的场景传 `full-height`。
   */
  fullHeight?: boolean
  title?: string
  /** 参与快照文件名（`<slug>-<sessionId前8位>.html`）。 */
  sessionId?: string
  /** 图片节点的缩略图 URL 解析器（由父组件注入，agent 侧栏通常拿不到画布的 blob URL）。 */
  resolveNodeUrl?: (nodeId: string) => string | undefined
}>()

const emit = defineEmits<{
  focusNode: [nodeId: string]
  /**
   * 在新窗口打开画布图（2026-07-24 改版）。
   *
   * ⭐ 语义从「覆盖画布区」改成「**开新窗口**」：覆盖层会有高度算不准、
   *   半透明透底、抢滚轮三个问题（用户实测反馈），而且无法与主画布**并存**。
   *   新窗口由浏览器保证全屏，且能和主窗口并排（各看各的）。
   */
  openInCanvasWindow: []
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
/**
 * 「在新窗口打开画布图」：打开**真实画布页** `/workflow/<sid>?graph=1`。
 *
 * ⭐ 为什么不是 blob 快照（与第三枚「导出 HTML」的区别）：
 *   - 这一枚给的是**活的应用**（同一 sessionId ⇒ 同一份画布数据、可继续对话）；
 *   - 第三枚给的是**静态文件**（可分享/存档，无缩略图）。
 *   两者用途不同，所以入口也不同。
 * ⚠️ `?graph=1` 让新窗口直接进入「全屏图视图」分支 ⇒ 跳过大画布首屏渲染。
 * ⚠️ `window.open` 可能被弹窗拦截器挡 ⇒ 明确 alert，不静默失败。
 */
function openCanvasWindow() {
  const sid = props.sessionId
  if (!sid) {
    window.alert("缺少会话 ID，无法打开新窗口。")
    return
  }
  const url = `/workflow/${encodeURIComponent(sid)}?graph=1`
  const win = window.open(url, "_blank", "noopener,noreferrer")
  if (!win) {
    window.alert("浏览器拦截了新窗口。\n请允许本站弹出窗口后重试。")
  }
}

/**
 * 「导出为 HTML 文件」：生成独立 HTML 快照并 `window.open`。
 *
 * ⚠️ 用 **Blob + objectURL** 而不是 data: URL —— data: URL 在部分浏览器会被拦，
 *    且长内容会撞 URL 长度上限。
 * ⚠️ 快照**不含缩略图**：载荷里没有图片 URL（见 node-graph-export.ts 文件头）。
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

      <!-- 🔀 三个动作入口（2026-07-24 改版）。
           ⚠️ 隐喻的选择（用户反馈：「导入」像下载、「浏览器打开」不形象）：
             ① **新窗口打开** ⇒ 一个方框 + 右上角斜出的小箭头 = "另开一个窗口看"，
                比 expand 四角箭头更准确（它就是开新窗口，不是展开面板）。
             ② **导入到画布** ⇒ 一个**画布框内长出小节点**（框 + 内含小方块 + 上箭头），
                ⛔ 不再用"箭头向下进托盘"—— 那个隐喻= 下载，语义反了。
             ③ **导出 HTML** ⇒ 一个**文档角标**（右上角折角 + 三条文字线），
                比"浏览器 + 外链"更直接说明产物是**文件**。
           顺序 = 使用频率：新窗口（最常用）→ 导入 → 导出。 -->
      <span class="agent-graph-actions ml-auto flex items-center gap-0.5">
        <button
          type="button"
          class="agent-graph-action"
          title="在新窗口打开画布图"
          aria-label="在新窗口打开"
          data-testid="ng-action-expand"
          @click="openCanvasWindow"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M2.5 4.2v-1a.7.7 0 01.7-.7h8.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <rect x="2.5" y="3.5" width="9" height="10" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M8.6 11.6l4.6-4.6M11 7h2.2v2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="agent-graph-action"
          title="导入到画布（建成节点）"
          aria-label="导入到画布"
          data-testid="ng-action-import"
          @click="emit('importToCanvas')"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="1.6" y="2.4" width="12.8" height="11.2" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4" />
            <rect x="5" y="8.2" width="6" height="3.6" rx="0.9" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="M8 6.6V3.2m0 0L6.4 4.8M8 3.2l1.6 1.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          class="agent-graph-action"
          title="导出为 HTML 文件（快照 / 可分享）"
          aria-label="导出 HTML"
          data-testid="ng-action-open-window"
          @click="openInNewWindow"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 1.9h5.2L13 5.7v8.4a.7.7 0 01-.7.7H4a.7.7 0 01-.7-.7V2.6a.7.7 0 01.7-.7z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
            <path d="M9.2 1.9v3.8H13" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
            <path d="M5.9 9h4.2M5.9 11.3h4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </span>
    </header>

    <!--⭐ 高度判据：默认 320px（气泡内）；传了 `h-full` / 父级有确定高度时**铺满**。
         旧实现写死 `h-[320px]` ⇒ 外层传 `h-full` 无效 ⇒ 用户反馈"高度没全屏拉满"。 -->
    <div
      class="relative w-full overflow-hidden rounded-md border border-[var(--neo-border)]"
      :class="fullHeight ? 'h-full' : 'h-[320px]'"
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
/* ── 卡片底色差异化（2026-07-24）────────────────────────────────────────
   判据：**比气泡背景亮一档**，而不是"浮起来"。
   - 浅色主题：纯白卡片落在偏暖灰的气泡背景上 → 边界清晰但不抢眼；
   - 深色主题：用「比背景稍亮」的深灰（**不用纯白**——纯白卡片在深底上会形成
     刺眼白块，这正是旧 SVG 卡片的问题）。
   两套都靠 CSS 变量自适应，不写死颜色。 */
.agent-node-graph {
  background: var(--neo-graph-card-bg);
  border: 1px solid var(--neo-graph-card-border);
  border-radius: 10px;
  padding: 10px;
}

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