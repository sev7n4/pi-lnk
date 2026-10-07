import type { CanvasAction } from '@lnkpi/shared'
import { formatStructuredError } from '@/components/agent/executionStepErrors'
import { summarizeToolArgs } from '@/components/agent/toolArgSummary'
import {
  canvasActionLabel,
  formatDuration,
  labelFromTextReplace,
  nodeStatusLabel,
} from '@/components/agent/executionStepLabels'
import type { AgentPresentationEnvelope } from '@/components/agent/presentation/types'

export type ExecutionStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'waiting_user'
  | 'skipped'

export type ExecutionStepKind =
  | 'phase'
  | 'text_stage'
  | 'canvas'
  | 'tool'
  | 'node_gen'
  | 'task'
  | 'thinking'
  | 'explore'

export interface ExecutionStep {
  id: string
  kind: ExecutionStepKind
  label: string
  detail?: string
  status: ExecutionStepStatus
  startedAt?: number
  endedAt?: number
  ms?: number
  meta?: {
    nodeId?: string
    taskId?: string
    toolName?: string
    toolCallId?: string
    args?: string
    errorCode?: string
  }
}

export interface ExecutionTraceState {
  steps: ExecutionStep[]
  collapsed: boolean
  turnStartedAt: number
  turnEndedAt?: number
  totalMs?: number
  /** P1 回合 token 实耗（turn_usage 事件覆盖写入，replay 幂等） */
  usage?: { inputTokens: number; outputTokens: number }
}

let stepCounter = 0

function nextStepId(prefix: string): string {
  stepCounter += 1
  return `${prefix}-${stepCounter}-${Date.now()}`
}

export function createExecutionTrace(): ExecutionTraceState {
  return {
    steps: [],
    collapsed: true,
    turnStartedAt: Date.now(),
  }
}

function completeStep(step: ExecutionStep, status: ExecutionStepStatus = 'done') {
  const now = Date.now()
  step.status = status
  step.endedAt = now
  if (step.startedAt) step.ms = now - step.startedAt
}

function upsertTextStage(trace: ExecutionTraceState, label: string, detail?: string) {
  const last = trace.steps[trace.steps.length - 1]
  if (last?.kind === 'text_stage' && last.label === label && last.status === 'running') {
    if (detail) last.detail = detail
    completeStep(last)
    return
  }
  if (last?.kind === 'text_stage' && last.label === label && last.status === 'done') {
    return
  }
  const now = Date.now()
  const step: ExecutionStep = {
    id: nextStepId('text'),
    kind: 'text_stage',
    label,
    detail,
    status: 'done',
    startedAt: now,
    endedAt: now,
    ms: 0,
  }
  trace.steps.push(step)
}

function removeDuplicateTextStage(trace: ExecutionTraceState, label: string) {
  const idx = trace.steps.findIndex(
    (s) => s.kind === 'text_stage' && s.label === label && s.status === 'done',
  )
  if (idx >= 0) trace.steps.splice(idx, 1)
}

export function applyStep(
  trace: ExecutionTraceState,
  data: {
    id: string
    kind?: string
    label: string
    status: string
    detail?: string
    ms?: number
    nodeId?: string
  },
) {
  const status = data.status as ExecutionStepStatus
  let step = trace.steps.find((s) => s.id === data.id)
  const now = Date.now()
  if (!step) {
    step = {
      id: data.id,
      kind: 'phase',
      label: data.label,
      status,
      startedAt: now,
      meta: data.nodeId ? { nodeId: data.nodeId } : undefined,
      detail: data.detail,
    }
    trace.steps.push(step)
    removeDuplicateTextStage(trace, data.label)
  } else {
    step.label = data.label
    step.status = status
    if (data.detail) step.detail = data.detail
  }
  if (status === 'done' || status === 'failed' || status === 'waiting_user') {
    step.endedAt = now
    step.ms = data.ms ?? (step.startedAt ? now - step.startedAt : 0)
  }
}

export function applyPhaseHint(
  trace: ExecutionTraceState,
  data: { phase?: string; label: string },
) {
  const id = `phase-hint:${data.phase || 'gate'}`
  let step = trace.steps.find((s) => s.id === id)
  if (!step) {
    step = {
      id,
      kind: 'phase',
      label: data.label,
      status: 'waiting_user',
      startedAt: Date.now(),
    }
    trace.steps.push(step)
  } else {
    step.label = data.label
    step.status = 'waiting_user'
  }
}

export function applyStructuredError(
  trace: ExecutionTraceState,
  data: {
    message?: string
    error_type?: string
    retry_hint?: string
    tool_name?: string
  },
) {
  const { label, detail } = formatStructuredError(data)
  const now = Date.now()
  trace.steps.push({
    id: nextStepId('error'),
    kind: 'phase',
    label,
    detail,
    status: 'failed',
    startedAt: now,
    endedAt: now,
    ms: 0,
    meta: data.error_type ? { errorCode: data.error_type } : undefined,
  })
}

export function applyThinking(
  trace: ExecutionTraceState,
  data: { status: string; summary?: string },
) {
  const id = 'thinking:parse'
  let step = trace.steps.find((s) => s.id === id)
  if (!step) {
    step = {
      id,
      kind: 'thinking',
      label: '思考中…',
      status: data.status === 'done' ? 'done' : 'running',
      startedAt: Date.now(),
      detail: data.summary,
    }
    trace.steps.unshift(step)
  } else {
    step.status = data.status === 'done' ? 'done' : 'running'
    if (data.summary) step.detail = data.summary
    if (data.status === 'done') completeStep(step)
  }
}

export function applyExplore(
  trace: ExecutionTraceState,
  data: {
    label?: string
    nodeCount?: number
    nodeTitles?: string[]
    episodicUsed?: boolean
    topicSwitch?: boolean
  },
) {
  const titles = (data.nodeTitles || []).slice(0, 3).join('、')
  const suffix = (data.nodeCount || 0) > 3 ? '等' : ''
  const detailParts: string[] = []
  if (titles) detailParts.push(titles + suffix)
  if (data.topicSwitch) detailParts.push('已切换话题，未引用历史任务')
  else if (data.episodicUsed === false) detailParts.push('未引用历史对话')
  const now = Date.now()
  trace.steps.push({
    id: nextStepId('explore'),
    kind: 'explore',
    label: data.label || '参考画布上下文',
    detail: detailParts.join('；') || `已参考 ${data.nodeCount ?? 0} 个节点`,
    status: 'done',
    startedAt: now,
    endedAt: now,
    ms: 0,
  })
}

export function applyTextReplaceStage(trace: ExecutionTraceState, text: string) {
  const label = labelFromTextReplace(text)
  if (!label) return
  if (trace.steps.some((s) => s.kind === 'phase' && s.label === label)) return
  upsertTextStage(trace, label, text.slice(0, 120))
}

export function applyCanvasAction(trace: ExecutionTraceState, action: CanvasAction) {
  const label = canvasActionLabel(action)
  const nodeId = action.payload?.id
  const now = Date.now()
  const step: ExecutionStep = {
    id: nextStepId('canvas'),
    kind: 'canvas',
    label,
    status: 'done',
    startedAt: now,
    endedAt: now,
    ms: 0,
    meta: nodeId ? { nodeId } : undefined,
  }
  trace.steps.push(step)
}

export function applyNodeStatus(
  trace: ExecutionTraceState,
  data: { nodeId: string; status: string; url?: string },
) {
  const label = nodeStatusLabel(data.status)
  const isRunning = data.status === 'generating'
  const existing = trace.steps.find(
    (s) => s.kind === 'node_gen' && s.meta?.nodeId === data.nodeId && s.status === 'running',
  )
  if (existing) {
    existing.label = label
    if (isRunning) return
    completeStep(existing, data.status === 'failed' ? 'failed' : 'done')
    return
  }
  const now = Date.now()
  trace.steps.push({
    id: nextStepId('node'),
    kind: 'node_gen',
    label,
    status: isRunning ? 'running' : data.status === 'failed' ? 'failed' : 'done',
    startedAt: now,
    endedAt: isRunning ? undefined : now,
    ms: isRunning ? undefined : 0,
    meta: { nodeId: data.nodeId },
    detail: data.url ? '已生成预览' : undefined,
  })
}

export function applyToolCall(
  trace: ExecutionTraceState,
  name: string,
  result?: unknown,
  meta?: { toolCallId?: string; args?: string; isError?: boolean },
) {
  // toolCallId 优先精确匹配（支持同名并发）；无 id 时回退老语义：同 name 的 running 步
  const existing = meta?.toolCallId
    ? trace.steps.find((s) => s.kind === 'tool' && s.meta?.toolCallId === meta.toolCallId)
    : trace.steps.find(
        (s) => s.kind === 'tool' && s.meta?.toolName === name && s.status === 'running',
      )
  if (existing) {
    if (result === undefined) return // 重放/重复 start：幂等
    existing.detail = summarizeToolResult(result)
    // P0 错误链路：isError 结果标 failed（保留在时间线，红色 ✗ 由渲染层按 status 着色）
    completeStep(existing, meta?.isError ? 'failed' : 'done')
    return
  }
  const now = Date.now()
  trace.steps.push({
    id: nextStepId('tool'),
    kind: 'tool',
    label: meta?.args ? `调用 ${name} · ${meta.args}` : `调用 ${name}`,
    status: result !== undefined ? (meta?.isError ? 'failed' : 'done') : 'running',
    startedAt: now,
    endedAt: result !== undefined ? now : undefined,
    ms: result !== undefined ? 0 : undefined,
    meta: { toolName: name, toolCallId: meta?.toolCallId, args: meta?.args },
    detail: result !== undefined ? summarizeToolResult(result) : undefined,
  })
}

function summarizeToolResult(result: unknown): string | undefined {
  if (result == null) return undefined
  if (typeof result === 'string') return result.slice(0, 80)
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (typeof r.message === 'string') return r.message.slice(0, 80)
    if (typeof r.status === 'string') return r.status
  }
  return undefined
}

export function applyTaskUpdate(
  trace: ExecutionTraceState,
  data: {
    id: string
    status: string
    title?: string
    nodeId?: string
    errorHint?: string
    errorCode?: string
  },
) {
  const label = data.title ? `生成「${data.title}」` : '批量生成任务'
  let step = trace.steps.find((s) => s.kind === 'task' && s.meta?.taskId === data.id)
  if (!step) {
    const now = Date.now()
    step = {
      id: nextStepId('task'),
      kind: 'task',
      label,
      status: 'running',
      startedAt: now,
      meta: { taskId: data.id, nodeId: data.nodeId },
    }
    trace.steps.push(step)
  }
  if (data.status === 'running' || data.status === 'retrying') {
    step.status = 'running'
    step.label = data.status === 'retrying' ? `${label}（重试中）` : label
    return
  }
  if (data.status === 'done') {
    completeStep(step)
    return
  }
  if (data.status === 'failed' || data.status === 'needs_user') {
    step.detail = data.errorHint
    if (data.errorCode) {
      step.meta = { ...step.meta, errorCode: data.errorCode }
    }
    completeStep(step, data.status === 'needs_user' ? 'waiting_user' : 'failed')
  }
}

export function finalizeExecutionTrace(trace: ExecutionTraceState) {
  const now = Date.now()
  trace.turnEndedAt = now
  trace.totalMs = now - trace.turnStartedAt
  for (const step of trace.steps) {
    if (step.status === 'running') {
      completeStep(step)
    }
  }
}

export function visibleStepCount(trace: ExecutionTraceState): number {
  return trace.steps.length
}

/** P1：turn_usage 事件写入（重复调用覆盖不叠加——replay/多事件幂等）。 */
export function applyTurnUsage(
  trace: ExecutionTraceState,
  usage: { inputTokens: number; outputTokens: number },
) {
  trace.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

/** tokens 人类化：≥1k 显示 X.Xk（3400 → 3.4k），否则原数。 */
function formatTokens(total: number): string {
  if (total < 1000) return `${total}`
  return `${(Math.round(total / 100) / 10).toFixed(1)}k`
}

/** 从 propose_generation 步骤解析张数：args「N 个节点」数字优先，缺省计 1。 */
function proposeCount(step: ExecutionStep): number {
  const args = step.meta?.args ?? (() => {
    const prefix = '调用 propose_generation · '
    return step.label.startsWith(prefix) ? step.label.slice(prefix.length) : undefined
  })()
  const m = /(\d+)\s*个节点/.exec(args ?? '')
  return m ? Number(m[1]) : 1
}

/** P1 回合摘要行（done 后一次）：已创建 N 个节点 · 提议生成 M 张 · 用时 Ss · 消耗 X tokens。
 * 各段数据缺失时省略对应段；无任何内容返回 null。 */
export function turnSummaryLine(trace: ExecutionTraceState): string | null {
  const nodeCount = trace.steps.filter(
    (s) => s.kind === 'canvas' && s.label.startsWith('添加'),
  ).length
  const proposeSteps = trace.steps.filter(
    (s) => s.kind === 'tool' && s.meta?.toolName === 'propose_generation',
  )
  const imageCount = proposeSteps.reduce((sum, s) => sum + proposeCount(s), 0)
  const segments: string[] = []
  if (nodeCount > 0) segments.push(`已创建 ${nodeCount} 个节点`)
  if (imageCount > 0) segments.push(`提议生成 ${imageCount} 张`)
  if (trace.totalMs != null) segments.push(`用时 ${formatDuration(trace.totalMs)}`)
  if (trace.usage) {
    segments.push(
      `消耗 ${formatTokens(trace.usage.inputTokens + trace.usage.outputTokens)} tokens`,
    )
  }
  return segments.length > 0 ? segments.join(' · ') : null
}

export function replayExecutionTraceEvents(
  events: Array<{ type: string; data: unknown }>,
): ExecutionTraceState {
  const trace = createExecutionTrace()
  for (const event of events) {
    switch (event.type) {
      case 'text_replace':
        applyTextReplaceStage(trace, String((event.data as { text?: string })?.text ?? ''))
        break
      case 'tool_call': {
        // ⚠️ 必须透传 toolCallId + args（2026-10-06 修）：落库事件两者都带
        // （pi-events.ts tool_execution_start 映射），只取 name 会让刷新后
        // 重放出的步骤丢参数摘要 ⇒ 标签从「创建节点 · 三国英雄照片」降级成「创建节点」，
        // 且同名并发调用的 result 会靠 name 兜底错配。
        const d = event.data as { name?: string; args?: unknown; toolCallId?: string }
        const name = String(d.name ?? 'tool')
        applyToolCall(trace, name, undefined, {
          toolCallId: d.toolCallId,
          args: summarizeToolArgs(name, d.args),
        })
        break
      }
      case 'tool_result': {
        const d = event.data as { name?: string; result?: unknown; isError?: boolean; toolCallId?: string }
        applyToolCall(
          trace,
          String(d.name ?? 'tool'),
          d.result,
          { toolCallId: d.toolCallId, isError: d.isError === true },
        )
        break
      }
      case 'canvas_action':
        applyCanvasAction(trace, event.data as CanvasAction)
        break
      case 'node_status':
        applyNodeStatus(trace, event.data as { nodeId: string; status: string; url?: string })
        break
      case 'step':
        applyStep(trace, event.data as Parameters<typeof applyStep>[1])
        break
      case 'phase_hint':
        applyPhaseHint(trace, event.data as { phase?: string; label: string })
        break
      case 'thinking':
        applyThinking(trace, event.data as { status: string; summary?: string })
        break
      case 'turn_usage':
        applyTurnUsage(trace, event.data as { inputTokens: number; outputTokens: number })
        break
      case 'explore':
        applyExplore(trace, event.data as Parameters<typeof applyExplore>[1])
        break
      case 'task_update':
        applyTaskUpdate(trace, event.data as Parameters<typeof applyTaskUpdate>[1])
        break
      case 'task_list': {
        // I-1 修复：replay switch 缺 task_list case → task 步标题退化为「批量生成任务」兜底。
        // 遍历 items 用 applyTaskUpdate 建 running 步并传 title；后续 task_update 通过 id 合并状态。
        const d = event.data as { items?: Array<{ id?: string; title?: string; status?: string }> }
        for (const item of d.items ?? []) {
          applyTaskUpdate(trace, {
            id: item.id ?? '',
            status: item.status ?? 'running',
            title: item.title,
          })
        }
        break
      }
      case 'error':
        applyStructuredError(
          trace,
          event.data as {
            message?: string
            error_type?: string
            retry_hint?: string
            tool_name?: string
          },
        )
        break
      default:
        break
    }
  }
  finalizeExecutionTrace(trace)
  return trace
}

/**
 * 从落库的 `executionEvents` 里重放 svg_card 卡片（spec §4.6 第 3 跳：刷新恢复）。
 *
 * **为什么单独一个函数、而不是给 `replayExecutionTraceEvents` 加 case**：
 * 卡片要写的是 `msg.presentation`，而 reducer 的契约是「只返回 `ExecutionTraceState`、
 * 不碰 store」（既有调用点 `stores/agent.ts` 的 `executionTrace` 赋值形状不能变）。
 * 让 reducer 顺手产出 presentation 会把两个字段的产出混在一个返回值里，
 * 破坏纯函数边界。故此处保持同样的纯函数形态：入参事件数组，出参 envelope，
 * 由 store 侧决定写到哪条消息上。
 *
 * **单值语义**：`presentation` 是单值字段，同轮多张卡**后者胜出**（与实时路径
 * `setPresentation` 逐张覆盖一致）。因此倒序遍历返回首个命中即「最后一张」。
 * 回归锁：`stores/agent.setPresentation.test.ts` 的「同轮第二张卡覆盖第一张」+
 * 本函数 describe 的「同轮多卡取最后一张」。
 *
 * **判据用 `svg !== undefined` 而非真值**，与服务端 `presentResult` 和
 * `AgentSideRail.hasRenderableSvgCard` 同因：超 `SVG_MAX_CHARS` 时下发 `svg: ""`
 * （字段在、值为空），那张卡有专属的「已丢弃」可见文案，必须照样恢复。
 */
export function replaySvgCardPresentation(
  events: Array<{ type: string; data: unknown }>,
): AgentPresentationEnvelope | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'canvas_command') continue
    const cmd = event.data as {
      type?: string
      svg?: string
      title?: string
      annotations?: Array<{ nodeId: string; text: string; severity: 'info' | 'warn' }>
    }
    if (cmd?.type !== 'svg_card' || cmd.svg === undefined) continue
    return {
      kind: 'svg_card',
      // 落库通道不记 stepper（服务端只存 cmd 本身），与实时路径同款空 stepper：
      // svg_card 走独立挂载不进 AgentPresentationHost，stepper 不会被渲染。
      stepper: { current: '', completed: [] },
      title: cmd.title,
      body: { svg: cmd.svg, annotations: cmd.annotations },
    }
  }
  return undefined
}
