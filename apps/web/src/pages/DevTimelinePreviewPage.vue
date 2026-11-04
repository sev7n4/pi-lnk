<script setup lang="ts">
/**
 * 开发预览页（仅 dev）：/dev/timeline-preview
 *
 * 目的：不依赖后端/真实会话，直接用**真实组件**渲染一条黄金事件序列，
 * 让「旧版（trace 槽位布局）」与「新版（TurnTimeline 时间线）」并排对比，
 * 并可逐步播放（模拟流式），肉眼验证设计稿 §3 的五个现象是否被修掉。
 *
 * 左：新版 turn_timeline（parts 顺序 = 事件到达序，思考分段交错、产物原位、摘要最末）
 * 右：旧版槽位布局（执行过程块 + 正文 + 产物 + 摘要行）
 */
import { computed, onUnmounted, ref } from 'vue'
import AgentTurnTimeline from '@/components/agent/AgentTurnTimeline.vue'
import AgentExecutionTrace from '@/components/agent/AgentExecutionTrace.vue'
import AgentCanvasOutputs from '@/components/agent/AgentCanvasOutputs.vue'
import {
  applyTimelineEvent,
  createTurnTimeline,
  finalizeTurnTimeline,
  type TimelineEvent,
  type TimelinePart,
  type TurnTimeline,
} from '@/components/agent/turnTimeline'
import type { ProposalCanvasNode } from '@/composables/useProposalNodeData'
import {
  applyCanvasAction,
  applyNodeStatus,
  applyThinking,
  applyToolCall,
  applyTurnUsage,
  createExecutionTrace,
  finalizeExecutionTrace,
  turnSummaryLine,
  type ExecutionTraceState,
} from '@/components/agent/executionTraceReducer'
import type { CanvasAction, LinkedCanvasOutput } from '@lnkpi/shared'

const THUMB = 'https://picsum.photos/seed/cybercat/240/240'
const NODE_A = 'node-cyber-cat'
const NODE_B = 'node-cyber-city'

/** 黄金事件序列：模拟一次「思考→探索→建节点→提议生成→确认→生成→收尾」的完整回合。 */
const GOLDEN: TimelineEvent[] = [
  { type: 'thinking', data: { status: 'running', summary: '用户想要一张赛博朋克风格的猫' } },
  { type: 'thinking', data: { status: 'done', summary: '用户想要一张赛博朋克风格的猫，先看画布已有内容' } },

  { type: 'text_delta', data: { text: '我先看一下画布上现有的节点。' } },
  { type: 'tool_call', data: { toolCallId: 't1', name: 'explore_canvas', args: {} } },
  { type: 'tool_result', data: { toolCallId: 't1', name: 'explore_canvas', result: { message: '画布上有 2 个节点（风格参考）' } } },

  { type: 'canvas_action', data: { type: 'add_node', payload: { id: NODE_A, nodeType: 'image', data: { title: '赛博朋克猫', prompt: 'cyberpunk cat' } } } as unknown as CanvasAction },

  // 第二段思考：与工具交错（旧版会被折叠/置顶，这是核心差异）
  { type: 'thinking', data: { status: 'running', summary: '需要调用图像生成模型，先提议生成让用户确认' } },
  { type: 'thinking', data: { status: 'done', summary: '需要调用图像生成模型，先提议生成让用户确认' } },

  { type: 'text_delta', data: { text: '我来为你生成一张赛博朋克风格的猫。' } },
  { type: 'tool_call', data: { toolCallId: 't2', name: 'propose_generation', args: { prompt: 'cyberpunk cat, neon', nodeId: NODE_A } } },
  { type: 'tool_result', data: { toolCallId: 't2', name: 'propose_generation', result: { status: 'pending_confirm' } } },

  { type: 'waiting_user', data: { status: 'waiting', toolName: 'propose_generation', nodeId: NODE_A, reason: '等待确认生成' } },

  // 用户点击「画布生成」
  { type: 'waiting_user', data: { status: 'resolved', toolName: 'propose_generation', nodeId: NODE_A } },
  { type: 'node_status', data: { nodeId: NODE_A, status: 'generating' } },
  { type: 'node_status', data: { nodeId: NODE_A, status: 'done', url: THUMB } },

  // 第三个节点：一次回合多产物
  { type: 'canvas_action', data: { type: 'add_node', payload: { id: NODE_B, nodeType: 'video', data: { title: '赛博城市', prompt: 'cyberpunk city' } } } as unknown as CanvasAction },
  { type: 'node_status', data: { nodeId: NODE_B, status: 'done', url: THUMB } },

  { type: 'thinking', data: { status: 'running', summary: '产物已就绪，收尾' } },
  { type: 'thinking', data: { status: 'done', summary: '产物已就绪，收尾' } },
  { type: 'turn_usage', data: { inputTokens: 12400, outputTokens: 860, cost: 0.052 } },
]

// ── 播放状态 ────────────────────────────────────────────────
const cursor = ref(0)
const playing = ref(false)
const speed = ref(420) // ms/步
let timer: number | undefined

const timeline = ref<TurnTimeline>(createTurnTimeline())
const trace = ref<ExecutionTraceState>(createExecutionTrace())
const oldText = ref('') // 旧模型：单段 content 字符串（appendText 语义）
const streaming = ref(false)

function reset() {
  if (timer) window.clearInterval(timer)
  timer = undefined
  playing.value = false
  cursor.value = 0
  timeline.value = createTurnTimeline()
  trace.value = createExecutionTrace()
  oldText.value = ''
  streaming.value = true
}

/** 把一条事件同时喂给新旧两条链路。 */
function step() {
  if (cursor.value >= GOLDEN.length) {
    if (timer) window.clearInterval(timer)
    timer = undefined
    playing.value = false
    streaming.value = false
    finalizeTurnTimeline(timeline.value)
    finalizeExecutionTrace(trace.value)
    return
  }
  const event = GOLDEN[cursor.value]
  applyTimelineEvent(timeline.value, event)

  // 旧链路的等价映射
  switch (event.type) {
    case 'thinking':
      applyThinking(trace.value, event.data as { status: string; summary?: string })
      break
    case 'text_delta':
      oldText.value += event.data.text
      break
    case 'tool_call':
      applyToolCall(trace.value, event.data.name, undefined, {
        toolCallId: event.data.toolCallId,
        args: JSON.stringify(event.data.args ?? {}),
      })
      break
    case 'tool_result':
      applyToolCall(trace.value, event.data.name, event.data.result, {
        toolCallId: event.data.toolCallId,
        isError: event.data.isError,
      })
      break
    case 'canvas_action':
      applyCanvasAction(trace.value, event.data)
      break
    case 'node_status':
      applyNodeStatus(trace.value, event.data)
      break
    case 'turn_usage':
      applyTurnUsage(trace.value, event.data)
      break
    default:
      break
  }
  cursor.value += 1
}

function play() {
  if (playing.value) {
    if (timer) window.clearInterval(timer)
    timer = undefined
    playing.value = false
    return
  }
  if (cursor.value >= GOLDEN.length) reset()
  playing.value = true
  streaming.value = true
  timer = window.setInterval(step, speed.value)
}

/** 直接跳到末尾（一次性看结果）。 */
function jumpEnd() {
  if (timer) window.clearInterval(timer)
  timer = undefined
  playing.value = false
  reset()
  streaming.value = false
  while (cursor.value < GOLDEN.length) step()
}

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})

// ── 派生（旧版布局）────────────────────────────────────────
const oldSummary = computed(() => turnSummaryLine(trace.value))
const oldOutputs = computed<LinkedCanvasOutput[]>(() =>
  timeline.value.parts
    .filter((p) => p.kind === 'artifact')
    .map((p) => ({
      nodeId: (p as { nodeId: string }).nodeId,
      title: (p as { title: string }).title,
      nodeType: (p as { nodeType: string }).nodeType,
      status: 'done' as const,
    })),
)
function resolveNodeUrl(nodeId: string): string | undefined {
  return nodeId === NODE_A || nodeId === NODE_B ? THUMB : undefined
}

// ── E2-a 回合产物幽灵摘要 · 六场景预览（规格 2026-11-04-e2a-ghost-delivery-summary §5）──
// 预览页无 MOBILE_NODE_OPEN_VIEWER_KEY provide ⇒ tile tap 一律走 focusNode 降级（场景⑥语义）。
type E2aArtifactPart = Extract<TimelinePart, { kind: 'artifact' }>
const ap = (
  nodeId: string,
  nodeType: string,
  title: string,
  status: E2aArtifactPart['status'],
  url?: string,
): E2aArtifactPart =>
  ({
    kind: 'artifact',
    id: `a-${nodeId}`,
    nodeId,
    nodeType,
    title,
    status,
    ...(url ? { url } : {}),
  }) as E2aArtifactPart

const e2aDone = (nodeId: string, nodeType: string, title: string, url?: string) =>
  ap(nodeId, nodeType, title, 'done', url)

const e2aScenarios: Array<{
  name: string
  parts: TimelinePart[]
  nodes: ProposalCanvasNode[]
}> = [
  {
    name: '① 单图 done',
    parts: [e2aDone('g1', 'image', '概念图', THUMB)],
    nodes: [{ id: 'g1', type: 'image', data: { url: THUMB } }],
  },
  {
    name: '② 四格批量',
    parts: [
      e2aDone('g1', 'image', '概念图 A', THUMB),
      e2aDone('g2', 'image', '概念图 B', THUMB),
      e2aDone('g3', 'image', '概念图 C'),
      e2aDone('g4', 'image', '概念图 D'),
    ],
    nodes: [
      { id: 'g1', type: 'image', data: { url: THUMB } },
      { id: 'g2', type: 'image', data: { url: THUMB } },
    ],
  },
  {
    name: '③ 混合四类（video 时长徽标 / audio·text 类型 tile）',
    parts: [
      e2aDone('g1', 'image', '概念图', THUMB),
      e2aDone('g2', 'video', '宣传片'),
      e2aDone('g3', 'audio', 'bgm'),
      e2aDone('g4', 'text', '文案'),
    ],
    nodes: [{ id: 'g2', type: 'video', data: { durationMs: 84_000 } }],
  },
  {
    name: '⑤ 失败不计入（行内重试卡照旧）',
    parts: [
      e2aDone('g1', 'image', '概念图', THUMB),
      ap('g9', 'image', '概念图 F', 'failed'),
    ],
    nodes: [{ id: 'g1', type: 'image', data: { url: THUMB } }],
  },
]

// ④ 补拍回填：按钮切换模拟 backfill 回填晚到 done（计数反应式更新，无新事件）
const e2aBackfillDone = ref(false)
const e2aBackfillParts = computed<E2aArtifactPart[]>(() =>
  e2aBackfillDone.value
    ? [
        e2aDone('b1', 'image', '概念图 1', THUMB),
        e2aDone('b2', 'image', '概念图 2'),
      ]
    : [e2aDone('b1', 'image', '概念图 1', THUMB)],
)
const e2aBackfillNodes: ProposalCanvasNode[] = [{ id: 'b1', type: 'image', data: { url: THUMB } }]

// ⑥ 桌面路由降级：focusNode emit 回显
const e2aLastFocus = ref('')

reset()
</script>

<template>
  <div class="mx-auto max-w-[1180px] p-6 text-[13px] text-[var(--neo-fg)]">
    <header class="mb-4">
      <h1 class="text-[18px] font-semibold">Agent 回合时间线 · 开发预览</h1>
      <p class="mt-1 text-[12px] text-[var(--neo-text-muted)]">
        左侧 = 新版 <code>TurnTimeline</code>（parts 顺序即事件到达序）；右侧 = 旧版槽位布局（执行过程块 + 正文 + 产物 + 摘要行）。
        同一条黄金事件序列同时喂给两条链路。
      </p>
      <div class="mt-3 flex items-center gap-2">
        <button
          class="rounded border border-[var(--neo-border)] px-3 py-1 text-[12px] hover:bg-[var(--neo-hover)]"
          @click="play"
        >{{ playing ? '暂停' : cursor === 0 ? '播放' : '继续' }}</button>
        <button
          class="rounded border border-[var(--neo-border)] px-3 py-1 text-[12px] hover:bg-[var(--neo-hover)]"
          @click="jumpEnd"
        >直接看结果</button>
        <button
          class="rounded border border-[var(--neo-border)] px-3 py-1 text-[12px] hover:bg-[var(--neo-hover)]"
          @click="reset"
        >重置</button>
        <span class="ml-2 text-[12px] text-[var(--neo-text-muted)]">进度 {{ cursor }}/{{ GOLDEN.length }}</span>
      </div>
    </header>

    <div class="grid grid-cols-2 gap-5">
      <!-- 新版 -->
      <section class="rounded-lg border border-[var(--neo-border)] p-4">
        <div class="mb-3 flex items-center gap-2">
          <span class="rounded bg-[var(--neo-accent-soft,rgba(120,120,255,.16))] px-2 py-0.5 text-[11px] font-medium">新版 · TurnTimeline</span>
          <span class="text-[11px] text-[var(--neo-text-muted)]">思考分段交错 · 产物原位 · 摘要最末</span>
        </div>
        <div class="rounded-md border border-[var(--agent-assistant-divider)] bg-[var(--agent-assistant-bg-soft)] p-3">
          <AgentTurnTimeline
            :parts="timeline.parts"
            :resolve-node-url="resolveNodeUrl"
            :streaming="streaming"
          />
        </div>
      </section>

      <!-- 旧版 -->
      <section class="rounded-lg border border-[var(--neo-border)] p-4">
        <div class="mb-3 flex items-center gap-2">
          <span class="rounded bg-[var(--neo-hover,rgba(255,255,255,.08))] px-2 py-0.5 text-[11px] font-medium">旧版 · 槽位布局</span>
          <span class="text-[11px] text-[var(--neo-text-muted)]">执行过程块 → 正文 → 产物 → 摘要行</span>
        </div>
        <div class="rounded-md border border-[var(--agent-assistant-divider)] bg-[var(--agent-assistant-bg-soft)] p-3">
          <AgentExecutionTrace
            :trace="trace"
            :streaming="streaming"
            :collapsed="false"
            @focus-node="() => {}"
          />
          <p v-if="oldText" class="mt-2 whitespace-pre-wrap text-[var(--neo-fg)]">{{ oldText }}</p>
          <div v-if="oldOutputs.length" class="mt-2">
            <AgentCanvasOutputs
              :outputs="oldOutputs"
              :resolve-node-url="resolveNodeUrl"
              @focus-node="() => {}"
              @focus-all="() => {}"
            />
          </div>
          <p v-if="!streaming && oldSummary" class="mt-1 pl-4 text-[10px] text-[var(--neo-text-muted)]">
            {{ oldSummary }}
          </p>
        </div>
      </section>
    </div>

    <section class="mt-5 rounded-lg border border-[var(--neo-border)] p-4">
      <div class="mb-2 text-[12px] font-medium">新版 parts 序列（调试视图）</div>
      <ol class="flex flex-col gap-0.5 text-[11px] text-[var(--neo-text-muted)]">
        <li v-for="(p, i) in timeline.parts" :key="p.id">
          {{ i + 1 }}. <b class="text-[var(--neo-fg)]">{{ p.kind }}</b>
          <template v-if="p.kind === 'thinking'">（{{ p.status }}）{{ p.text }}</template>
          <template v-else-if="p.kind === 'tool'">（{{ p.status }}）{{ p.toolName }}</template>
          <template v-else-if="p.kind === 'artifact'">（{{ p.status }}）{{ p.title }}</template>
          <template v-else-if="p.kind === 'text'">（{{ p.status }}）{{ p.text.slice(0, 40) }}</template>
          <template v-else-if="p.kind === 'notice'">（{{ p.tone }}）{{ p.text }}</template>
          <template v-else-if="p.kind === 'canvas'">{{ p.label }}</template>
        </li>
      </ol>
    </section>

    <!-- E2-a 回合产物幽灵摘要 · 六场景（规格 §5）：静态 parts 驱动，肉眼验收显隐/计数/tile 形态 -->
    <section class="mt-5 rounded-lg border border-[var(--neo-border)] p-4">
      <div class="mb-1 text-[12px] font-medium">E2-a 回合产物幽灵摘要 · 六场景</div>
      <p class="mb-3 text-[11px] text-[var(--neo-text-muted)]">
        预览页无 viewer provide ⇒ tile tap 走 focusNode 降级（场景⑥语义）；移动端真机请在会话页验收 viewer 直开。
      </p>
      <div class="grid grid-cols-2 gap-4">
        <div
          v-for="s in e2aScenarios"
          :key="s.name"
          class="rounded-md border border-[var(--agent-assistant-divider)] bg-[var(--agent-assistant-bg-soft)] p-3"
        >
          <div class="mb-1 text-[11px] font-medium">{{ s.name }}</div>
          <AgentTurnTimeline
            :parts="s.parts"
            :canvas-nodes="s.nodes"
            :resolve-node-url="resolveNodeUrl"
            @focus-node="e2aLastFocus = $event"
          />
        </div>
        <div class="rounded-md border border-[var(--agent-assistant-divider)] bg-[var(--agent-assistant-bg-soft)] p-3">
          <div class="mb-1 flex items-center gap-2">
            <span class="text-[11px] font-medium">④ 补拍回填（计数反应式更新）</span>
            <button
              class="rounded border border-[var(--neo-border)] px-2 py-0.5 text-[11px] hover:bg-[var(--neo-hover)]"
              @click="e2aBackfillDone = !e2aBackfillDone"
            >{{ e2aBackfillDone ? '回填前' : '模拟 backfill 回填' }}</button>
          </div>
          <AgentTurnTimeline
            :parts="e2aBackfillParts"
            :canvas-nodes="e2aBackfillNodes"
            :resolve-node-url="resolveNodeUrl"
            @focus-node="e2aLastFocus = $event"
          />
        </div>
        <div class="rounded-md border border-[var(--agent-assistant-divider)] bg-[var(--agent-assistant-bg-soft)] p-3">
          <div class="mb-1 text-[11px] font-medium">⑥ 桌面路由降级（无 viewer provide ⇒ 定位）</div>
          <AgentTurnTimeline
            :parts="e2aScenarios[0]!.parts"
            :canvas-nodes="e2aScenarios[0]!.nodes"
            :resolve-node-url="resolveNodeUrl"
            @focus-node="e2aLastFocus = $event"
          />
          <p class="mt-1 text-[11px] text-[var(--neo-text-muted)]">最近 focusNode：{{ e2aLastFocus || '（未点击）' }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
