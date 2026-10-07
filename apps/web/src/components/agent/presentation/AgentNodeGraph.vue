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

/** 与后端 `services/pi-runtime/src/tools/types-node-graph.ts` 对齐（勿单方面改字段名）。 */
interface GraphNode {
  id: string
  type?: string
  title?: string
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  groupId?: string
  status?: 'idle' | 'running' | 'failed'
}
interface GraphEdge {
  source: string
  target: string
  label?: string
}
interface NodeGraphBody {
  title?: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  droppedNodeIds?: string[]
  totalNodeCount?: number
}

const props = defineProps<{
  body: NodeGraphBody
  title?: string
  /** 图片节点的缩略图 URL 解析器（由父组件注入，agent 侧栏通常拿不到画布的 blob URL）。 */
  resolveNodeUrl?: (nodeId: string) => string | undefined
}>()

const emit = defineEmits<{
  focusNode: [nodeId: string]
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
</style>