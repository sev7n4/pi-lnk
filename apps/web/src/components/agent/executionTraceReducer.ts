import type { CanvasAction } from '@lnkpi/shared'
import { formatStructuredError } from '@/components/agent/executionStepErrors'
import { summarizeToolArgs } from '@/components/agent/toolArgSummary'
import {
  canvasActionLabel,
  formatDuration,
  labelFromTextReplace,
  nodeStatusLabel,
} from '@/components/agent/executionStepLabels'
import type { AgentPresentationEnvelope, NodeGraphBodyPayload } from '@/components/agent/presentation/types'

/**
 * 执行轨迹步骤状态。
 *
 * ⚠️ `waiting_user` 与其余状态**不同类**（ADR-0011 T8，2026-10-20 协议语义对齐）：
 * 其余是「工具产出 / 进度」（pending→running→done/failed，可自行推进），
 * `waiting_user` 是**阻塞态**——run 停在这里等 host 把决策交回用户，语义等价于上游
 * coding-agent 的 `ui_prompt_start/end`（`core/extensions/types.ts:745-759`）：
 * 把「正在等用户」建模成事件，而不是让 host 从工具结果反推。
 * 渲染落点（唯一锚定表面）见 ProposeConfirmOverlay / ADR-0011。
 */
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
  /** P1 回合 token 实耗（turn_usage 事件覆盖写入，replay 幂等）。
   * cost：服务端 pi-events createUsageAccumulator 折叠的 usage.cost 总额
   * （渠道未配 pricing 时字段不出现——0 视为「未计费」不携带）。
   * P2 T5：cacheReadTokens/cacheWriteTokens 三列分开（inputTokens = 纯 input）；
   * 旧落库事件无 cache 字段 → 键不出现，摘要合计按 0 兜底。 */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    cost?: number
    estimatedCredits?: number
  }
  /** P2 T7：turn_settled 结算明细（turn_settled 事件覆盖写入，replay 幂等）。
   * 事件四形态：正常 {credits, breakdown?, tokens?, ruleVersion?} / degraded
   * {credits, degraded:true} / released {released:true}（预扣全退）。
   * 终审 I-1 双口径分离：breakdown = 积分成分（个位，计费口径 cacheWrite 并入
   * in），tokens = 原始 token 数（千级，展示口径 in/cacheRead/out 直取）——
   * 渲染只读 tokens.*，formatTokens 语义归位；breakdown 留事件供未来展开。
   * 键不出现纪律：credits/breakdown/tokens/ruleVersion/degraded/released 仅在
   * 服务端下发该键时携带（条件展开），缺省段由 turnSettledText 按形态兜底。 */
  settled?: {
    holdId: string
    credits?: number
    breakdown?: { in: number; cache: number; out: number }
    tokens?: { in: number; cache: number; out: number }
    ruleVersion?: string
    degraded?: boolean
    released?: boolean
  }
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

/**
 * P0（agent-turn-timeline-design §5）：思考**分段**且**不再置顶**。
 *
 * ⚠️ 旧实现用固定 id `thinking:parse` + `steps.unshift`：
 *   - 固定 id ⇒ 同一回合内所有思考段被折叠成「一个」块（用户口径「一次思考」）；
 *   - unshift ⇒ 该块永远钉在队头，即使它发生在若干工具之后（时间序被破坏）。
 *
 * 新实现（不动后端契约——pi-events.createThinkingAccumulator 已在每个
 * thinking_start 发 `running`、每个 thinking_end 发 `done+summary`，多段思考
 * 本就分别到达）：
 *   - `running`（thinking_start）：若无「正在 running 的思考段」则新建一段并 **push 到尾部**；
 *     若有（异常：start 未伴 done 即再次 start）则复用，避免重复块。
 *   - 终态（done）：落到**最近一段 running 思考**；找不到则找最后一段 thinking
 *     （兼容缺 start 的重放 / 上游只发 end）；再兜底新建 done 段到尾部。
 * 结果：多段思考按真实时间序与工具交错出现，首块不再恒为 thinking。
 */
export function applyThinking(
  trace: ExecutionTraceState,
  data: { status: string; summary?: string; segmentId?: string },
) {
  if (data.status === 'running') {
    const running = trace.steps.find((s) => s.kind === 'thinking' && s.status === 'running')
    if (running) {
      if (data.summary) running.detail = data.summary
      return
    }
    trace.steps.push({
      id: nextStepId('thinking'),
      kind: 'thinking',
      label: '思考中…',
      status: 'running',
      startedAt: Date.now(),
      detail: data.summary,
    })
    return
  }
  // 终态（done 或任何非 running）：优先落到最近一段 running 思考；否则最后一段 thinking。
  let target: ExecutionStep | undefined
  for (let i = trace.steps.length - 1; i >= 0; i -= 1) {
    const s = trace.steps[i]
    if (s.kind !== 'thinking') continue
    if (s.status === 'running') {
      target = s
      break
    }
    if (!target) target = s
  }
  if (target) {
    target.status = 'done'
    if (data.summary) target.detail = data.summary
    completeStep(target)
  } else {
    // 防御：没有任何思考段，直接追加 done 段到尾部（兼容缺 start 的脏数据）。
    trace.steps.push({
      id: nextStepId('thinking'),
      kind: 'thinking',
      label: '思考完成',
      status: 'done',
      startedAt: Date.now(),
      endedAt: Date.now(),
      ms: 0,
      detail: data.summary,
    })
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
  // ⚠️ 「未完成」（批次 3.1）不是成功：既不是 running 也不是 completed。
  // 若当成 done，时间线会显示绿色 ✓ ＝「这步成功了」⇒ 说谎。
  // 归到 failed（现有档位里唯一表示「没成功」的）⇒ 渲染层按 failed 着色。
  // （当前后端经 update_node 写画布、不发 node_status 事件 ⇒ 这是防御性分支。）
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

/** P1：turn_usage 事件写入（重复调用覆盖不叠加——replay/多事件幂等）。
 * cost 仅在合法有限数时透传（P1 cost 接线：渠道 models[].pricing → vendor
 * calculateCost → 服务端 turn_usage.cost；未配价 = 字段不出现，行为不变）。
 * P2 T5：cacheReadTokens/cacheWriteTokens 同款条件透传（旧事件无字段 → 键不出现）。 */
export function applyTurnUsage(
  trace: ExecutionTraceState,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    cost?: number
    estimatedCredits?: number
  },
) {
  trace.usage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(typeof usage.cacheReadTokens === 'number' && Number.isFinite(usage.cacheReadTokens)
      ? { cacheReadTokens: usage.cacheReadTokens }
      : {}),
    ...(typeof usage.cacheWriteTokens === 'number' && Number.isFinite(usage.cacheWriteTokens)
      ? { cacheWriteTokens: usage.cacheWriteTokens }
      : {}),
    ...(typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? { cost: usage.cost } : {}),
    ...(typeof usage.estimatedCredits === 'number' && Number.isFinite(usage.estimatedCredits)
      ? { estimatedCredits: usage.estimatedCredits }
      : {}),
  }
}

/** tokens 人类化：≥1k 显示 X.Xk（3400 → 3.4k），否则原数。 */
function formatTokens(total: number): string {
  if (total < 1000) return `${total}`
  return `${(Math.round(total / 100) / 10).toFixed(1)}k`
}

/** P2 T7：turn_settled 事件写入（重复调用覆盖不叠加——replay/重复事件幂等）。
 * 键不出现纪律照 applyTurnUsage 同款条件展开（服务端 Task 6 条件下发）。 */
export function applyTurnSettled(
  trace: ExecutionTraceState,
  data: {
    holdId: string
    credits?: number
    breakdown?: { in: number; cache: number; out: number }
    tokens?: { in: number; cache: number; out: number }
    ruleVersion?: string
    degraded?: boolean
    released?: boolean
  },
) {
  trace.settled = {
    holdId: data.holdId,
    ...(typeof data.credits === 'number' && Number.isFinite(data.credits)
      ? { credits: data.credits }
      : {}),
    ...(data.breakdown ? { breakdown: { ...data.breakdown } } : {}),
    ...(data.tokens ? { tokens: { ...data.tokens } } : {}),
    ...(data.ruleVersion ? { ruleVersion: data.ruleVersion } : {}),
    ...(data.degraded === true ? { degraded: true } : {}),
    ...(data.released === true ? { released: true } : {}),
  }
}

/** P2 T7：settled 段文案——turnSummaryLine 摘要段与 turnStatusBar 状态行**共用**
 * 这一个生成器（文案单源，不许复制两份）。
 * released →「预扣已退回」（预扣全退不显示负数）；degraded →「已结算 -N 积分（按成本估算）」；
 * 正常 →「已结算 -N 积分（输入 X.Xk · 缓存 X.Xk · 输出 X.Xk）」——按 **tokens**（原始
 * token 数）渲染，formatTokens 语义归位（终审 I-1：breakdown 是积分成分，个位数被
 * 当 token 渲染会失真，绝不再读它出文案；缺 tokens 键的旧形状回退无 token 段）。
 * 差额规则：reducer 已跟踪 estimatedCredits（applyTurnUsage），|实际 − 预估| ≥ 2 积分
 * 时追加「（预估 M）」。非 settled 回合 / credits 缺失（异常形态）返回 null。 */
export function turnSettledText(trace: ExecutionTraceState | undefined | null): string | null {
  const settled = trace?.settled
  if (!settled) return null
  if (settled.released) return '预扣已退回'
  if (typeof settled.credits !== 'number' || !Number.isFinite(settled.credits)) return null
  let text: string
  if (settled.degraded) {
    text = `已结算 -${settled.credits} 积分（按成本估算）`
  } else if (settled.tokens) {
    text = `已结算 -${settled.credits} 积分（输入 ${formatTokens(settled.tokens.in)} · 缓存 ${formatTokens(settled.tokens.cache)} · 输出 ${formatTokens(settled.tokens.out)}）`
  } else {
    text = `已结算 -${settled.credits} 积分`
  }
  const estimated = trace.usage?.estimatedCredits
  if (
    typeof estimated === 'number'
    && Number.isFinite(estimated)
    && Math.abs(settled.credits - estimated) >= 2
  ) {
    text += `（预估 ${Math.ceil(estimated)}）`
  }
  return text
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
    // P2 T5：inputTokens 已收窄为纯 input，合计 = in + cacheRead + cacheWrite + out
    // （旧事件无 cache 字段 → 0 兜底），用户可见总量不缩水。
    const totalTokens =
      trace.usage.inputTokens +
      (trace.usage.cacheReadTokens ?? 0) +
      (trace.usage.cacheWriteTokens ?? 0) +
      trace.usage.outputTokens
    segments.push(`消耗 ${formatTokens(totalTokens)} tokens`)
    // P1 cost 展示（最后一厘米）：费率单位跟随渠道 pricing 配置，此处不带货币符号。
    if (trace.usage.cost != null) {
      segments.push(`费用 ≈${Number(trace.usage.cost.toPrecision(3))}`)
    }
  }
  // P2 T7：settled 段（与状态行共用 turnSettledText，文案单源）。
  const settledText = turnSettledText(trace)
  if (settledText) segments.push(settledText)
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
        applyTurnUsage(
          trace,
          event.data as {
            inputTokens: number
            outputTokens: number
            cacheReadTokens?: number
            cacheWriteTokens?: number
            cost?: number
          },
        )
        break
      case 'turn_settled':
        // P2 T7：结算明细随既有 executionEvents 重放通道还原（覆盖写入，幂等）。
        applyTurnSettled(trace, event.data as Parameters<typeof applyTurnSettled>[1])
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
/**
 * 落库重放：`node_graph` 载荷（2026-07）。
 *
 * ⚠️ 与 `replaySvgCardPresentation` **并列**而非替换 —— 双写期两条都可能在事件流里。
 * 调用方按「有 node_graph 就用它」的优先级取舍（见 AgentSideRail）。
 *
 * 为什么必须单独写：落库通道不存 stepper（服务端只存 cmd 本身），
 * 与 svg_card 同款空 stepper；`node_graph` 走独立挂载，不进 AgentPresentationHost。
 */
/** `node_graph` 呈现信封（独立挂载，不进 AgentPresentationHost 的 stepper）。 */
export type NodeGraphEnvelope = Omit<AgentPresentationEnvelope, 'kind'> & {
  kind: 'node_graph'
}

export function replayNodeGraphPresentation(
  events: Array<{ type: string; data: unknown }>,
): NodeGraphEnvelope | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'canvas_command') continue
    const cmd = event.data as {
      type?: string
      nodes?: unknown
      edges?: unknown
      title?: string
      droppedNodeIds?: unknown
      totalNodeCount?: unknown
    }
    if (cmd?.type !== 'node_graph' || !Array.isArray(cmd.nodes)) continue
    return {
      kind: 'node_graph',
      stepper: { current: '', completed: [] },
      title: cmd.title,
      // ⚠️ 与 SideRail 实时路径同款：用 `AgentPresentationBody` 的可选字段承载
      //   （联合类型会污染所有下游 body 访问，见 types.ts 的注释）。
      body: {
        graph_nodes: cmd.nodes as NodeGraphBodyPayload['nodes'],
        graph_edges: (Array.isArray(cmd.edges) ? cmd.edges : []) as NodeGraphBodyPayload['edges'],
        graph_droppedNodeIds: Array.isArray(cmd.droppedNodeIds) ? cmd.droppedNodeIds : undefined,
        graph_totalNodeCount: typeof cmd.totalNodeCount === 'number' ? cmd.totalNodeCount : undefined,
        nodeGraphTitle: cmd.title,
      },
    }
  }
  return undefined
}

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

/** RB-D6②（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：本轮 trace 是否存在 failed 步骤。 */
export function hasFailedTraceStep(steps: { status?: string }[] | undefined): boolean {
  return (steps ?? []).some((s) => s.status === 'failed')
}
