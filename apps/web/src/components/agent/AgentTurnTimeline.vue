<script setup lang="ts">
/**
 * P1 — TurnTimeline 渲染件（设计稿 §5-P1 / §10 D1-D2）。
 *
 * 渲染规则（设计 §4 规则 2/3）：无「执行过程」总折叠块，每个 part 独立渲染、按 parts 顺序
 * （= 事件到达序）。折叠粒度 = 单个 part。复用既有 presentToolStep / DockTypeIcon /
 * CanvasLocateButton，零新增设计令牌。
 *
 * - thinking：🧠 可折叠块（running 显示脉冲点）
 * - text：正文（whitespace-pre-wrap，无额外装饰）
 * - tool：icon + 动词·参数，展开看结果；failed 红色
 * - canvas：一行「🖼️ label」+ 定位
 * - artifact：紧凑卡（状态机 pending/running/done/failed），done 出缩略图，
 *   failed 出内联重试入口（D2）+ 错误文案；点击/定位复用现有画布能力
 * - notice：按 tone 着色；error 带重试按钮
 */
import { computed, shallowReactive } from 'vue'
import DockTypeIcon from '@/components/canvas/dock-studio/shared/DockTypeIcon.vue'
import CanvasLocateButton from '@/components/shared/CanvasLocateButton.vue'
import { presentToolStep } from '@/components/agent/toolPresentation'
import { useDisclosure } from '@/components/agent/useDisclosure'
import type { TimelinePart, ThinkingPart } from '@/components/agent/turnTimeline'

const props = defineProps<{
  parts: TimelinePart[]
  /** 画布节点 url 解析器（SideRail 由 canvasNodes 提供）；缺省=旧行为纯文本行 */
  resolveNodeUrl?: (nodeId: string) => string | undefined
  streaming?: boolean
  /**
   * P2-2：dense = 活体钉底（composer 上方）变体。**只调行密度与折叠默认值**，
   * 不改 parts 语义、不改顺序、不做截断——与历史气泡共用同一份渲染逻辑，
   * 消除「live dense trace vs history 气泡」两套组件导致(vii)的布局跳变（设计 §3 现象 5）。
   */
  dense?: boolean
}>()

const emit = defineEmits<{
  retryNode: [nodeId: string]
  focusNode: [nodeId: string]
}>()

const VIDEO_URL_RE = /\.(mp4|webm|mov)(\?|$)/i

function isVideoUrl(url: string): boolean {
  return VIDEO_URL_RE.test(url)
}

/**
 * 2026-10-14（生产实证）：模型会在两段文本之间吐 3+ 连续换行（本例 11 个），
 * whitespace-pre-wrap 原样渲染成大块空白。渲染层折叠 3+ 换行为空行（保留段落间距语义）。
 */
function collapseBlankRuns(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

function toolLabel(p: Extract<TimelinePart, { kind: 'tool' }>): string {
  const shown = presentToolStep({
    label: p.toolName,
    kind: 'tool',
    status: p.status,
    meta: { toolName: p.toolName, args: p.args },
  })
  return shown.label
}
function toolIcon(p: Extract<TimelinePart, { kind: 'tool' }>): string {
  const shown = presentToolStep({ label: p.toolName, kind: 'tool', meta: { toolName: p.toolName, args: p.args } })
  return shown.icon
}

function artifactUrl(p: Extract<TimelinePart, { kind: 'artifact' }>): string | undefined {
  const url = props.resolveNodeUrl?.(p.nodeId)
  return typeof url === 'string' && url ? url : undefined
}

function statusIcon(status: string): string {
  switch (status) {
    case 'done':
      return '✓'
    case 'failed':
      return '✗'
    case 'running':
      return '⏳'
    case 'pending':
      return '○'
    default:
      return '○'
  }
}

function onLocate(nodeId: string) {
  emit('focusNode', nodeId)
}
function onRetry(nodeId: string) {
  emit('retryNode', nodeId)
}

/** 流式中：最后一个「streaming 文本块」尾部显示光标，对齐旧正文的 ▊。 */
function isStreamingCursor(part: TimelinePart): boolean {
  if (!props.streaming) return false
  if (part.kind !== 'text' || part.status !== 'streaming') return false
  const last = props.parts[props.parts.length - 1]
  return last?.kind === 'text' && last.id === part.id
}

const toneClass = (tone: 'info' | 'warn' | 'error') =>
  tone === 'error'
    ? 'text-danger'
    : tone === 'warn'
      ? 'text-[var(--neo-text-secondary)]'
      : 'text-[var(--neo-text-muted)]'

const hasContent = computed(() => props.parts.length > 0)

/**
 * 思考块的折叠契约（2026-10-14）：用户意图优先于展示默认值。
 *
 * 每个 thinking part 持有**独立**的 disclosure 实例，按 part.id 缓存 —— 重建 parts
 * 数组（同 id）时复用同一实例，用户点过的选择因此能跨 patch 存活。
 *
 * ⚠️ 缓存键必须是 part.id 而非数组下标：parts 会随流式增长/重排，下标会错位。
 */
type Disclosure = ReturnType<typeof useDisclosure>

/**
 * 用 `shallowReactive` 而非 `reactive`：后者会**深度解包 ref**，
 * 使 Map 里存的对象变成 `{ isOpen: boolean }`（`.value` 消失、类型被改写）。
 * 这里要的就是「Map 本身可追踪、但内部实例保持原样」。
 */
const thinkingDisclosures = shallowReactive(new Map<string, Disclosure>())

/**
 * 思考块当前是否有流式快照（展示默认值的**唯一**响应式来源）。
 *
 * ⚠️ 必须从 `props.parts` 派生并保持响应式，不能在 `useDisclosure` 的回调里
 * 现查现算：那样 `getDefault` 的求值时机落在 computed 的依赖追踪之外，
 * parts 换新对象时结果不会被重算（CI 实测：running→done 后仍不自动收起）。
 * 抽成独立 computed 后，Vue 能把它记进依赖链，parts 变化即触发重算。
 */
function isRunningThinking(id: string): boolean {
  return props.parts.some((p) => p.kind === 'thinking' && p.id === id && p.status === 'running')
}

function disclosureFor(part: ThinkingPart): Disclosure {
  let d = thinkingDisclosures.get(part.id)
  if (!d) {
    // 默认值读响应式派生的 isRunningThinking —— 实时、且被 computed 正确追踪。
    // ⛔ 不可写成 `() => part.status === 'running'`：捕获首次渲染的 part 引用，
    // replay 用同 id 新对象替换旧 part 后默认值会锁死在旧 status 上（CI 实测踩过）。
    d = useDisclosure(() => isRunningThinking(part.id))
    thinkingDisclosures.set(part.id, d)
  }
  return d
}

function thinkingOpen(part: ThinkingPart): boolean {
  return disclosureFor(part).isOpen.value
}

function onThinkingToggle(part: ThinkingPart, nativeOpen: boolean): void {
  disclosureFor(part).onNativeToggle(nativeOpen)
}

/**
 * 2026-10-15（三滚动条治理 2/2）：dense 根的限高滚动**恢复**，但语境已完全不同——
 * live 态对话内容已移回 `.agent-chat-scroll` 主滚动流（dock 滚动容器整体删除），
 * 卡片自身的 `max-height + overflow-y` 现在是**唯一允许的内嵌滚动**
 * （用户口径「composer 上方只有思考消息流自带滚动条，其余是一整套页面」）。
 *
 * 历史脉络：1/2 曾删掉这道限高，因为当时它与 dock 外层 `.agent-dock-scroll--scrollable`
 * 构成两层嵌套滚动（流式回合三条竖直滚动条的第三条）；2/2 外层已不存在，
 * 卡片内滚不再嵌套，且是内容超长时的唯一防线。规则本体在 AgentSideRail.vue 的
 * `.agent-turn-timeline--dense`（限高 min(46vh,420px)），不在本组件——
 * 历史气泡内（非 dense）形态不加，跟随主滚动流。
 */

/** 容器：dense（活体钉底）收紧行距与字号；其余完全一致（同一套 parts 渲染）。 */
const rootClass = computed(() =>
  props.dense
    ? 'agent-turn-timeline agent-turn-timeline--dense flex flex-col gap-0.5 text-[10px] leading-snug'
    : 'agent-turn-timeline flex flex-col gap-1 text-[11px] leading-snug',
)
</script>

<template>
  <div v-if="hasContent" :class="rootClass">
    <template v-for="part in parts" :key="part.id">
      <!-- thinking：折叠契约（2026-10-14）——展示默认值（running 展开 / done 收起）仅在
           用户未表达意图时生效；用户点过后由 @toggle 记录意图，后续 patch 不再改写。
           ⛔ 不可写成 `<details :open="part.status === 'running'">`：那会把默认值当受控值，
           running 期间恒 true ⇒ 用户点了收起，下个 patch 就被强制弹回（生产反馈：收不回）。 -->
      <details
        v-if="part.kind === 'thinking'"
        class="group rounded border border-[var(--agent-assistant-divider)] bg-[var(--agent-assistant-bg-soft)] px-2 py-1"
        :open="thinkingOpen(part)"
        @toggle="onThinkingToggle(part, ($event.target as HTMLDetailsElement).open)"
      >
        <summary class="flex cursor-pointer items-center gap-1.5 text-[var(--neo-text-muted)]">
          <span>🧠</span>
          <span class="font-medium">{{ part.status === 'running' ? '思考中' : '思考' }}</span>
          <span
            v-if="part.status === 'running'"
            class="ml-auto inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--neo-text-muted)]"
          />
        </summary>
        <p
          class="mt-1 whitespace-pre-wrap text-[var(--neo-text-secondary)]"
        >{{ collapseBlankRuns(part.text) }}<span v-if="part.status === 'running'" class="animate-pulse">▊</span></p>
      </details>

      <!-- text：dense 不限行（2026-10-17）——原 line-clamp-3 让流式期间只看 3 行、
           收束后气泡接管才显全文，用户感知「整回合结束才一次性吐出」。dense 根本就有
           min(46vh,420px) 限高内滚（见下方 <style>），超长自行滚动，无需截断兜底。 -->
      <p
        v-else-if="part.kind === 'text'"
        class="whitespace-pre-wrap text-[var(--neo-fg)]"
      >{{ collapseBlankRuns(part.text) }}<span v-if="isStreamingCursor(part)" class="animate-pulse">▊</span></p>

      <!-- tool：有 resultSummary 才包 details（可展开看结果）；
           无摘要时渲染纯行——空 details 是「点了没内容」的死交互（2026-10-14 生产反馈） -->
      <div
        v-else-if="part.kind === 'tool'"
        class="rounded border border-[var(--agent-assistant-divider)] px-2 py-1"
        :class="part.status === 'failed' ? 'border-danger/40' : ''"
      >
        <details v-if="part.resultSummary">
          <summary class="flex cursor-pointer items-center gap-1.5">
            <span>{{ toolIcon(part) }}</span>
            <span :class="part.status === 'failed' ? 'text-danger' : 'text-[var(--neo-text-secondary)]'">{{ toolLabel(part) }}</span>
            <span
              v-if="part.status === 'running'"
              class="ml-auto inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--neo-text-muted)]"
            />
            <span v-else-if="part.status === 'done'" class="ml-auto text-[var(--neo-text-muted)]">✓</span>
            <span v-else-if="part.status === 'failed'" class="ml-auto text-danger">✗</span>
          </summary>
          <p class="mt-1 whitespace-pre-wrap text-[10px] text-[var(--neo-text-muted)]">{{ part.resultSummary }}</p>
        </details>
        <div v-else class="flex items-center gap-1.5">
          <span>{{ toolIcon(part) }}</span>
          <span :class="part.status === 'failed' ? 'text-danger' : 'text-[var(--neo-text-secondary)]'">{{ toolLabel(part) }}</span>
          <span
            v-if="part.status === 'running'"
            class="ml-auto inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--neo-text-muted)]"
          />
          <span v-else-if="part.status === 'done'" class="ml-auto text-[var(--neo-text-muted)]">✓</span>
          <span v-else-if="part.status === 'failed'" class="ml-auto text-danger">✗</span>
        </div>
      </div>

      <!-- canvas -->
      <div
        v-else-if="part.kind === 'canvas'"
        class="flex items-center gap-1.5 text-[var(--neo-text-muted)]"
      >
        <span>🖼️</span>
        <span>{{ part.label }}</span>
        <CanvasLocateButton
          v-if="part.nodeId"
          title="在画布中定位"
          @click="onLocate(part.nodeId!)"
        />
      </div>

      <!-- artifact -->
      <div
        v-else-if="part.kind === 'artifact'"
        class="flex items-center gap-1.5 rounded border border-[var(--agent-assistant-divider)] px-2 py-1"
        :class="part.status === 'failed' ? 'border-danger/40' : ''"
      >
        <span
          class="w-3 shrink-0 text-center"
          :class="part.status === 'failed' ? 'text-danger' : 'text-[var(--neo-text-muted)]'"
        >{{ statusIcon(part.status) }}</span>
        <span
          v-if="part.status === 'done' && artifactUrl(part)"
          class="relative block h-7 w-7 shrink-0 overflow-hidden rounded border border-[var(--neo-border)]"
        >
          <video
            v-if="isVideoUrl(artifactUrl(part)!)"
            :src="`${artifactUrl(part)}#t=0.1`"
            muted
            preload="metadata"
            class="h-full w-full object-cover"
          />
          <img
            v-else
            :src="artifactUrl(part)"
            :alt="part.title"
            loading="lazy"
            class="h-full w-full object-cover"
          />
        </span>
        <DockTypeIcon v-else :type="part.nodeType" :size="12" class="shrink-0 opacity-80" />
        <span
          class="min-w-0 flex-1 truncate"
          :class="part.status === 'failed' ? 'text-danger' : 'text-[var(--neo-fg)]'"
        >{{ part.title }}</span>
        <span
          v-if="part.status === 'running' || part.status === 'pending'"
          class="shrink-0 text-[10px] text-[var(--neo-text-muted)] animate-pulse"
        >{{ part.status === 'pending' ? '待确认' : '生成中…' }}</span>
        <CanvasLocateButton
          v-if="part.status === 'done' || part.status === 'failed'"
          title="在画布中定位"
          @click="onLocate(part.nodeId)"
        />
        <button
          v-if="part.status === 'failed'"
          type="button"
          class="shrink-0 rounded border border-danger/50 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10"
          @click="onRetry(part.nodeId)"
        >重试生成</button>
      </div>

      <!-- notice -->
      <div
        v-else-if="part.kind === 'notice'"
        class="flex items-start gap-1.5"
        :class="toneClass(part.tone)"
      >
        <span class="shrink-0">{{ part.tone === 'error' ? '⚠' : part.tone === 'warn' ? '⏸' : '·' }}</span>
        <span class="min-w-0 flex-1">
          {{ part.text }}
          <span v-if="part.retryLabel" class="ml-1 opacity-80">{{ part.retryLabel }}</span>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 2026-10-15（三滚动条治理 2/2）：dense（live 活体）根的限高滚动——
 * 唯一允许的内嵌滚动（用户口径「composer 上方的对话内容是一整套页面，
 * 只有思考消息流自带滚动条」）。live 内容已入 .agent-chat-scroll 主滚动流，
 * 本规则是卡片内容超长时的唯一防线，不与任何外层滚动容器嵌套。
 * 历史气泡内（非 dense）不加：跟随主滚动流。规则放本组件而非父级 scoped，
 * 避免依赖「子组件根带父 scope attr」的隐式命中（换父即静默失效）。 */
.agent-turn-timeline--dense {
  max-height: min(46vh, 420px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
</style>
