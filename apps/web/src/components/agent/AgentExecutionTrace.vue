<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ExecutionTraceState, ExecutionStep } from '@/components/agent/executionTraceReducer'
import { formatDuration } from '@/components/agent/executionStepLabels'
import { presentToolStep, timelineHeadline } from '@/components/agent/toolPresentation'
import { turnSummaryLine } from '@/components/agent/executionTraceReducer'
import { derivePhase, PHASE_BADGE } from '@/components/agent/phaseAggregator'
import CanvasLocatePinIcon from '@/components/shared/CanvasLocatePinIcon.vue'

const props = defineProps<{
  trace: ExecutionTraceState
  streaming?: boolean
  /** 钉底模式（本轮活体过程）：只渲染一行「N 步 · 最新人话」摘要，点开展开，不渲染底部分隔线。 */
  dense?: boolean
  /**
   * 折叠状态（受控，2026-10-07）。缺省时回退 `trace.collapsed`（保持旧调用点兼容）。
   *
   * ⚠️ 为什么必须受控：此前展开态只活在组件内部 ref，而reducer 的 `trace.collapsed`
   * 每次写入（流式过程会反复写）都会经 watch 把展开态拉回 ⇒ **用户刚展开就被收起**，
   * 表现为「打开后没法收起」。现在真相由父级持有，子组件只 emit 意图。
   */
  collapsed?: boolean
}>()

const emit = defineEmits<{
  focusNode: [nodeId: string]
  /** 上抛折叠状态变化，让 reducer 成为唯一真相（修复「展开后无法收起」） */
  'update:collapsed': [collapsed: boolean]
}>()

// 折叠以**父级传入的 collapsed 为唯一真相**，本地只做乐观镜像（点击后立即反馈，等 props 回流）。
// ⚠️ 2026-10-07 修「打开后没法收起」：此前真相只在本地 ref，而 reducer 每次写 trace.collapsed
//   （流式过程会反复写）都会经 watch 把展开态拉回 ⇒ 刚展开就被收起。
const expanded = ref(!(props.collapsed ?? props.trace.collapsed))

watch(
  () => props.collapsed ?? props.trace.collapsed,
  (v) => {
    expanded.value = !v
  },
)

const stepCount = computed(() => props.trace.steps.length)

const headerLabel = computed(() => {
  const count = stepCount.value
  if (props.streaming) {
    if (count === 0) return '执行过程（进行中…）'
    return `执行过程（进行中… · ${count} 步）`
  }
  if (count === 0) return '执行过程'
  // P1 认知负荷：折叠头行附最新一步人话（N 步 · 最新：<icon> <label>）
  if (!expanded.value) {
    const headline = timelineHeadline(props.trace)
    if (headline.includes('· 最新：')) return `执行过程（${headline}）`
  }
  return `执行过程（${count} 步）`
})

const durationLabel = computed(() => {
  if (props.streaming) return '· 进行中…'
  if (props.trace.totalMs != null) return `· ${formatDuration(props.trace.totalMs)}`
  return ''
})

const showTrace = computed(
  // usage 存在即渲染：纯文本回合（无步骤）也要露出回合摘要行（tokens 实耗）；
  // 不用 totalMs 作门——否则老历史消息（无 usage）会多出重复的「执行过程」头行
  () => stepCount.value > 0 || props.streaming || props.trace.usage != null,
)

function toggle() {
  const next = !expanded.value
  expanded.value = next
  emit('update:collapsed', !next) // 注意：emit 的是 collapsed（取反）
}

function statusIcon(step: ExecutionStep): string {
  switch (step.status) {
    case 'done':
      return '✓'
    case 'failed':
      return '✗'
    case 'running':
      return '…'
    case 'waiting_user':
      return '!'
    case 'skipped':
      return '–'
    default:
      return '○'
  }
}

function stepDuration(step: ExecutionStep): string {
  if (step.ms == null || step.status === 'running') return ''
  if (step.ms === 0) return ''
  return ` · ${formatDuration(step.ms)}`
}

function onStepClick(step: ExecutionStep) {
  const nodeId = step.meta?.nodeId
  if (nodeId) emit('focusNode', nodeId)
}

/** P1 注册表：tool 步经人话化翻译（icon + 动词 · args），其余步骤维持原 label。 */
function stepDisplay(step: ExecutionStep): string {
  if (step.kind !== 'tool') return step.label
  return presentToolStep(step).label
}

const summaryLine = computed(() => turnSummaryLine(props.trace))

/** dense（钉底）头行：`N 步 · 最新：<icon> <人话>`，不重复「执行过程」四个字——状态行已承载。 */
const denseHeadline = computed(() => {
  const visible = props.trace.steps.filter((s) => s.kind !== 'phase')
  const last = visible[visible.length - 1]
  if (!last) return props.streaming ? '正在准备…' : '执行过程'
  const shown = presentToolStep(last)
  const prefix = visible.length > 1 ? `${visible.length} 步 · ` : ''
  return `${prefix}正在${shown.label}`
})

/** P1#4 阶段徽章：从 trace 步骤纯派生（仅流式期间显示）。 */
const phaseBadge = computed(() => {
  const p = derivePhase(props.trace.steps)
  return p ? PHASE_BADGE[p] : null
})
</script>

<template>
  <div
    v-if="showTrace"
    class="agent-trace"
    :class="dense ? 'mb-1' : 'mt-1.5 border-t border-white/10 pt-1.5'"
  >
    <button
      type="button"
      class="agent-trace-toggle flex w-full items-center gap-1 text-left text-[11px] text-[var(--neo-text-muted)] hover:text-[var(--neo-text-primary)]"
      @click="toggle"
    >
      <span class="inline-block w-3 shrink-0">{{ expanded ? '▾' : '▸' }}</span>
      <span
        v-if="phaseBadge && streaming"
        class="mr-1 inline-flex items-center gap-0.5 rounded-full bg-[var(--neo-panel)] px-1.5 py-0.5"
        data-testid="phase-badge"
      >{{ phaseBadge.icon }} {{ phaseBadge.label }}</span>
      <span :data-testid="dense ? 'trace-headline-dense' : 'trace-headline'">{{ dense ? denseHeadline : headerLabel }}</span>
      <span v-if="durationLabel && !expanded && !dense" class="opacity-70">{{ durationLabel }}</span>
    </button>
    <div v-if="expanded" class="mt-1 space-y-2 pl-4">
      <section v-if="stepCount > 0" data-testid="operation-section">
        <p class="mb-1 text-[10px] font-medium text-[var(--neo-text-muted)]">操作明细</p>
        <!-- 2026-10-09 修「展开操作明细后历史滚动被锁死」：dense（钉底活体）展开态给步骤 <ul>
             加 max-height + overflow-y:auto + overscroll-behavior:contain。
             ⚠️ 只挂 dense：气泡形态的 trace 本就在可滚消息列表里，再加内层滚动会双层滚。
             没有这个上限时长 thinking detail（whitespace-pre-wrap）会无限撑高 dock（shrink-0、
             `--scrollable` 修饰只挂 hasDockPresentation=showCancelledCallout，正常回合恒 false），
             把 chat-wrap（flex-1 min-h-0）挤到 0 高 ⇒ 历史列表不可见/不可滚 + 折叠头行命中区被顶飞。 -->
        <ul
          class="space-y-0.5"
          data-testid="operation-steps"
          :style="dense ? 'max-height: min(46vh, 420px); overflow-y: auto; overscroll-behavior: contain;' : undefined"
        >
          <li
            v-for="(step, i) in trace.steps"
            :key="step.id"
            data-testid="operation-step"
            class="agent-trace-step flex items-start gap-1.5 text-[10px] leading-snug"
            :style="{ animationDelay: `${Math.min(i * 60, 600)}ms` }"
            :class="[
              step.meta?.nodeId ? 'cursor-pointer hover:text-[var(--neo-text-primary)]' : '',
              step.status === 'failed' ? 'text-red-400/90' : 'text-[var(--neo-text-muted)]',
              step.status === 'running' ? 'animate-pulse' : '',
              step.kind === 'thinking' ? 'italic opacity-80' : '',
              step.kind === 'explore' ? 'opacity-90' : '',
              step.status === 'done' ? 'agent-trace-step--done' : '',
            ]"
            @click="onStepClick(step)"
          >
            <span class="min-w-0 flex-1">
              <span>{{ statusIcon(step) }} {{ stepDisplay(step) }}{{ stepDuration(step) }}</span>
              <p v-if="step.detail" class="mt-0.5 pl-3 opacity-75" :class="step.kind === 'thinking' ? 'whitespace-pre-wrap' : ''">{{ step.detail }}</p>
            </span>
            <CanvasLocatePinIcon
              v-if="step.meta?.nodeId"
              :size="11"
              class="mt-0.5 shrink-0 opacity-60"
            />
          </li>
        </ul>
      </section>
    </div>
    <!-- P1 回合摘要行：done 后一次（节点/张数/耗时/tokens） -->
    <p
      v-if="!streaming && summaryLine"
      data-testid="turn-summary-line"
      class="mt-1 pl-4 text-[10px] text-[var(--neo-text-muted)]"
    >
      {{ summaryLine }}
    </p>
  </div>
</template>

<style scoped>
/* P1 动效节拍：步骤 stagger 入场（delay 由行内 style 按 i*60ms 注入，上限 600ms） */
.agent-trace-step {
  animation: agent-trace-step-in 0.22s ease-out both;
}

.agent-trace-step--done {
  transition: opacity 0.2s ease;
}

@keyframes agent-trace-step-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-trace-step {
    animation: none;
  }
}
</style>
