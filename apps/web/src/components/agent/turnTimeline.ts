/**
 * P1 — TurnTimeline 模型层（设计稿 §4 / §5-P1）。
 *
 * 设计动机（G1/G3/G4）：上游给的是有序的 content-block 时间线，pi-lnk 在路上把它压成
 * 「一段文本 + 一列 steps」，再用固定模板槽位顺序假装成时间，导致「一次思考、摘要压在产物上、
 * 产物不原位」。本模块补上这一层：**`parts` 顺序即事件到达顺序，唯一真相**，渲染层只做
 * `parts.map()`，没有「执行过程」总折叠块、没有固定槽位。
 *
 * 与 `executionTraceReducer` 同形：纯函数、可单测、可 replay（历史 `executionEvents` 直重放）。
 * 但**不分组、不置顶、不去重**——think/tool/text/artifact/notice 各是 `parts` 里一个独立元素，
 * 按真实发生位置出现（现象 3/4 的解）。
 *
 * D 系列决议落点：
 * - D1：propose_generation 的产物 = 单个 `artifact` part（按 nodeId upsert），`update_node` 不建 part。
 * - D2：failed artifact 在 part 内带 errorText，由渲染层出内联重试（见 AgentTurnTimeline.vue）。
 * - 状态行（D3/D4）不在此层——它读 store 的 activity/usage，由 SideRail 渲染。
 */

import type { CanvasAction } from '@lnkpi/shared'
import { summarizeToolArgs } from '@/components/agent/toolArgSummary'
import {
  canvasActionLabel,
  formatDuration,
} from '@/components/agent/executionStepLabels'

export type TimelinePart =
  | {
      kind: 'thinking'
      id: string
      text: string
      status: 'running' | 'done'
      startedAt: number
      endedAt?: number
    }
  | {
      kind: 'text'
      id: string
      text: string
      status: 'streaming' | 'done'
    }
  | {
      kind: 'tool'
      id: string
      toolName: string
      args?: string
      status: 'running' | 'done' | 'failed'
      resultSummary?: string
      ms?: number
      nodeRef?: string
      isError?: boolean
    }
  | {
      kind: 'canvas'
      id: string
      label: string
      nodeId?: string
    }
  | {
      kind: 'artifact'
      id: string
      nodeId: string
      nodeType: string
      title: string
      status: 'pending' | 'running' | 'done' | 'failed'
      errorText?: string
    }
  | {
      kind: 'notice'
      id: string
      text: string
      tone: 'info' | 'warn' | 'error'
      /** D2：error notice 携带重试入口文案（由渲染层出按钮）。 */
      retryLabel?: string
    }

export interface TurnTimeline {
  parts: TimelinePart[]
  turnStartedAt: number
  turnEndedAt?: number
  usage?: { inputTokens: number; outputTokens: number; cost?: number }
}

export type TimelineUsage = { inputTokens: number; outputTokens: number; cost?: number }

export type TimelineEvent =
  | { type: 'text_delta'; data: { text: string } }
  | { type: 'thinking'; data: { status: string; summary?: string } }
  | { type: 'tool_call'; data: { toolCallId?: string; name: string; args?: unknown } }
  | {
      type: 'tool_result'
      data: { toolCallId?: string; name: string; result?: unknown; isError?: boolean }
    }
  | { type: 'canvas_action'; data: CanvasAction }
  | { type: 'node_status'; data: { nodeId: string; status: string; url?: string } }
  | { type: 'turn_usage'; data: TimelineUsage }
  | {
      type: 'waiting_user'
      data: { status?: string; toolName?: string; nodeId?: string; reason?: string }
    }
  | {
      type: 'error'
      data: { message?: string; error_type?: string; retry_hint?: string; tool_name?: string }
    }
  | {
      type: 'explore'
      data: {
        label?: string
        nodeCount?: number
        nodeTitles?: string[]
        episodicUsed?: boolean
        topicSwitch?: boolean
      }
    }
  | {
      type: 'task_update'
      data: {
        id: string
        status: string
        title?: string
        nodeId?: string
        errorHint?: string
        errorCode?: string
      }
    }
  | {
      type: 'task_list'
      data: { items?: Array<{ id?: string; title?: string; status?: string; nodeId?: string }> }
    }
  | {
      type: 'step'
      data: { id: string; kind?: string; label: string; status: string; detail?: string; nodeId?: string }
    }
  | { type: 'phase_hint'; data: { phase?: string; label: string } }
  | { type: 'message_start'; data?: unknown }
  | { type: 'message_end'; data?: unknown }
  // 历史重放专用（无 text_delta，只有覆盖语义的 text_replace）
  | { type: 'text_replace'; data: { text?: string } }

let partCounter = 0
function nextPartId(prefix: string): string {
  partCounter += 1
  return `${prefix}-${partCounter}-${Date.now()}`
}

export function createTurnTimeline(): TurnTimeline {
  return {
    parts: [],
    turnStartedAt: Date.now(),
  }
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

/** 把 node_status 的 vendor 状态映射到 artifact 状态机。 */
function nodeStatusToArtifact(status: string): 'pending' | 'running' | 'done' | 'failed' {
  switch (status) {
    case 'generating':
    case 'running':
      return 'running'
    case 'failed':
    case 'error':
      return 'failed'
    case 'pending':
      return 'pending'
    case 'done':
    case 'completed':
    default:
      return 'done'
  }
}

export function applyTimelineEvent(timeline: TurnTimeline, event: TimelineEvent): void {
  switch (event.type) {
    case 'text_delta': {
      const text = event.data.text ?? ''
      if (!text) return
      // 续接最后一个 streaming 文本块；否则新开一块（多段叙述各自成块，不覆盖）
      let part = [...timeline.parts].reverse().find((p): p is Extract<TimelinePart, { kind: 'text' }> => p.kind === 'text' && p.status === 'streaming')
      if (!part) {
        part = { kind: 'text', id: nextPartId('text'), text: '', status: 'streaming' }
        timeline.parts.push(part)
      }
      part.text += text
      return
    }
    case 'text_replace': {
      // 历史重放：text_replace 是覆盖语义的旧事件，转成单个 done 文本块（不续接、不丢）
      const text = String(event.data.text ?? '')
      if (!text) return
      const existing = timeline.parts.find((p) => p.kind === 'text')
      if (existing && existing.kind === 'text') {
        existing.text = text
        existing.status = 'done'
      } else {
        timeline.parts.push({ kind: 'text', id: nextPartId('text'), text, status: 'done' })
      }
      return
    }
    case 'thinking': {
      const d = event.data
      if (d.status === 'running') {
        const running = timeline.parts.find(
          (p): p is Extract<TimelinePart, { kind: 'thinking' }> =>
            p.kind === 'thinking' && p.status === 'running',
        )
        if (running) {
          if (d.summary) running.text = d.summary
          return
        }
        timeline.parts.push({
          kind: 'thinking',
          id: nextPartId('thinking'),
          text: d.summary ?? '',
          status: 'running',
          startedAt: Date.now(),
        })
        return
      }
      // 终态：落到最近一段 running 思考；否则最后一段 thinking；都没有则新建 done 段
      let target: Extract<TimelinePart, { kind: 'thinking' }> | undefined
      for (let i = timeline.parts.length - 1; i >= 0; i -= 1) {
        const p = timeline.parts[i]
        if (p.kind !== 'thinking') continue
        if (p.status === 'running') {
          target = p
          break
        }
        if (!target) target = p
      }
      if (target) {
        target.status = 'done'
        if (d.summary) target.text = d.summary
        target.endedAt = Date.now()
      } else {
        timeline.parts.push({
          kind: 'thinking',
          id: nextPartId('thinking'),
          text: d.summary ?? '',
          status: 'done',
          startedAt: Date.now(),
          endedAt: Date.now(),
        })
      }
      return
    }
    case 'tool_call': {
      const d = event.data
      const name = String(d.name ?? 'tool')
      const existing = d.toolCallId
        ? timeline.parts.find(
            (p): p is Extract<TimelinePart, { kind: 'tool' }> =>
              p.kind === 'tool' && p.id === `tool:${d.toolCallId}`,
          )
        : timeline.parts.find(
            (p): p is Extract<TimelinePart, { kind: 'tool' }> =>
              p.kind === 'tool' && p.toolName === name && p.status === 'running',
          )
      if (existing) return // 重放/重复 start 幂等
      timeline.parts.push({
        kind: 'tool',
        id: d.toolCallId ? `tool:${d.toolCallId}` : nextPartId('tool'),
        toolName: name,
        args: summarizeToolArgs(name, d.args),
        status: 'running',
      })
      return
    }
    case 'tool_result': {
      const d = event.data
      const name = String(d.name ?? 'tool')
      const existing = d.toolCallId
        ? timeline.parts.find(
            (p): p is Extract<TimelinePart, { kind: 'tool' }> =>
              p.kind === 'tool' && p.id === `tool:${d.toolCallId}`,
          )
        : timeline.parts.find(
            (p): p is Extract<TimelinePart, { kind: 'tool' }> =>
              p.kind === 'tool' && p.toolName === name && p.status === 'running',
          )
      const resultSummary = summarizeToolResult(d.result)
      if (existing) {
        existing.status = d.isError ? 'failed' : 'done'
        existing.isError = d.isError === true
        if (resultSummary) existing.resultSummary = resultSummary
        return
      }
      timeline.parts.push({
        kind: 'tool',
        id: d.toolCallId ? `tool:${d.toolCallId}` : nextPartId('tool'),
        toolName: name,
        status: d.isError ? 'failed' : 'done',
        isError: d.isError === true,
        resultSummary,
      })
      return
    }
    case 'canvas_action': {
      const action = event.data
      const nodeId = action.payload?.id
      const type = String(action.type ?? '')
      // D1：update_node 是内部写回，不建 part（propose 结果由 node_status 驱动 artifact）。
      if (type === 'update_node') return
      if (type === 'add_node' && nodeId) {
        // 节点创建 ⇄ 单个 artifact part（pending，等生成或 propose 确认）
        const nodeType = String(action.payload?.nodeType || 'image')
        // title/prompt 都在 payload.data 里（CanvasAction 无顶层 title，见 deriveLinkedOutputs）
        const title = String(
          action.payload?.data?.title || action.payload?.data?.prompt || '未命名',
        ).slice(0, 20)
        upsertArtifact(timeline, {
          nodeId: String(nodeId),
          nodeType,
          title,
          status: 'pending',
        })
        return
      }
      // 其它 canvas 动作（remove/connect/…）走 canvas part
      timeline.parts.push({
        kind: 'canvas',
        id: nextPartId('canvas'),
        label: canvasActionLabel(action),
        nodeId: nodeId ? String(nodeId) : undefined,
      })
      return
    }
    case 'node_status': {
      const d = event.data
      const status = nodeStatusToArtifact(d.status)
      const existing = timeline.parts.find(
        (p): p is Extract<TimelinePart, { kind: 'artifact' }> =>
          p.kind === 'artifact' && p.nodeId === d.nodeId,
      )
      if (existing) {
        existing.status = status
        if (d.status === 'failed') {
          existing.errorText = typeof d.url === 'string' && d.url ? d.url : '生成失败，可重试'
        }
        return
      }
      // 没有 add_node 先到（异常）：补一个 artifact 占位
      timeline.parts.push({
        kind: 'artifact',
        id: nextPartId('artifact'),
        nodeId: d.nodeId,
        nodeType: 'image',
        title: '未命名',
        status,
        errorText: d.status === 'failed' ? '生成失败，可重试' : undefined,
      })
      return
    }
    case 'turn_usage': {
      const u = event.data
      timeline.usage = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        ...(typeof u.cost === 'number' && Number.isFinite(u.cost) ? { cost: u.cost } : {}),
      }
      return
    }
    case 'waiting_user': {
      const d = event.data
      if (d.status === 'resolved') return
      const text =
        d.toolName === 'propose_generation'
          ? '等待你在画布上确认生成'
          : d.reason
            ? `等待你确认：${d.reason}`
            : '等待你确认'
      timeline.parts.push({
        kind: 'notice',
        id: nextPartId('notice'),
        text,
        tone: 'warn',
      })
      return
    }
    case 'error': {
      const d = event.data
      const text = d.message || d.retry_hint || '执行出错'
      timeline.parts.push({
        kind: 'notice',
        id: nextPartId('notice'),
        text,
        tone: 'error',
        retryLabel: d.retry_hint,
      })
      return
    }
    case 'explore': {
      const d = event.data
      const titles = (d.nodeTitles || []).slice(0, 3).join('、')
      const label = d.label || (titles ? `参考画布上下文：${titles}` : '参考画布上下文')
      timeline.parts.push({ kind: 'canvas', id: nextPartId('canvas'), label })
      return
    }
    case 'task_update':
    case 'task_list': {
      const items =
        event.type === 'task_update'
          ? [event.data]
          : (event.data.items ?? []).map((it) => ({
              id: it.id ?? '',
              status: it.status ?? 'running',
              title: it.title,
              nodeId: it.nodeId,
            }))
      for (const item of items) {
        const nodeId = (item as { nodeId?: string }).nodeId
        if (nodeId) {
          const status: 'pending' | 'running' | 'done' | 'failed' =
            item.status === 'failed' || item.status === 'needs_user'
              ? 'failed'
              : item.status === 'running' || item.status === 'retrying'
                ? 'running'
                : 'done'
          upsertArtifact(timeline, {
            nodeId,
            nodeType: 'image',
            title: String((item as { title?: string }).title ?? '批量生成任务').slice(0, 20),
            status,
            errorText:
              item.status === 'failed'
                ? String((item as { errorHint?: string }).errorHint ?? '生成失败，可重试')
                : undefined,
          })
        } else {
          timeline.parts.push({
            kind: 'notice',
            id: nextPartId('notice'),
            text: String((item as { title?: string }).title ?? '批量生成任务'),
            tone: 'info',
          })
        }
      }
      return
    }
    case 'step': {
      const d = event.data
      timeline.parts.push({
        kind: 'notice',
        id: nextPartId('notice'),
        text: d.detail ? `${d.label}：${d.detail}` : d.label,
        tone: d.status === 'failed' ? 'error' : 'info',
      })
      return
    }
    case 'phase_hint': {
      timeline.parts.push({
        kind: 'notice',
        id: nextPartId('notice'),
        text: event.data.label,
        tone: 'warn',
      })
      return
    }
    case 'message_start':
    case 'message_end':
    default:
      return
  }
}

/** artifact 按 nodeId upsert（D1：一次节点 = 一个 part）。 */
function upsertArtifact(
  timeline: TurnTimeline,
  data: { nodeId: string; nodeType: string; title: string; status: 'pending' | 'running' | 'done' | 'failed'; errorText?: string },
): void {
  const existing = timeline.parts.find(
    (p): p is Extract<TimelinePart, { kind: 'artifact' }> =>
      p.kind === 'artifact' && p.nodeId === data.nodeId,
  )
  if (existing) {
    existing.status = data.status
    if (data.title && existing.title === '未命名') existing.title = data.title
    if (data.status === 'failed') existing.errorText = data.errorText ?? '生成失败，可重试'
    return
  }
  timeline.parts.push({
    kind: 'artifact',
    id: nextPartId('artifact'),
    nodeId: data.nodeId,
    nodeType: data.nodeType,
    title: data.title,
    status: data.status,
    errorText: data.status === 'failed' ? (data.errorText ?? '生成失败，可重试') : undefined,
  })
}

/** 回合结束：收口 running 态、补摘要 notice（设计 §4 规则 4：摘要是末尾 notice）。 */
export function finalizeTurnTimeline(timeline: TurnTimeline): void {
  const now = Date.now()
  timeline.turnEndedAt = now
  for (const p of timeline.parts) {
    if (p.kind === 'thinking' && p.status === 'running') {
      p.status = 'done'
      p.endedAt = now
    }
    if (p.kind === 'text' && p.status === 'streaming') {
      p.status = 'done'
    }
    if (p.kind === 'tool' && p.status === 'running') {
      p.status = 'done'
    }
    if (p.kind === 'artifact' && p.status === 'running') {
      // 生成未在回合内收口：兜底翻 done（D1 兜底，避免卡在 running）
      p.status = 'done'
    }
  }
  const summary = summarizeTimeline(timeline)
  if (summary) {
    timeline.parts.push({
      kind: 'notice',
      id: nextPartId('notice'),
      text: summary,
      tone: 'info',
    })
  }
}

/** 摘要文案（复用 turnSummaryLine 的口径，但数据源是 parts）。 */
export function summarizeTimeline(timeline: TurnTimeline): string | null {
  const nodeCount = timeline.parts.filter(
    (p) => p.kind === 'canvas' || (p.kind === 'artifact' && p.status === 'done'),
  ).length
  const proposeSteps = timeline.parts.filter(
    (p) => p.kind === 'tool' && p.toolName === 'propose_generation',
  )
  const imageCount = proposeSteps.length
  const segments: string[] = []
  if (nodeCount > 0) segments.push(`已创建 ${nodeCount} 个节点`)
  if (imageCount > 0) segments.push(`提议生成 ${imageCount} 张`)
  if (timeline.turnEndedAt != null) {
    segments.push(`用时 ${formatDuration(timeline.turnEndedAt - timeline.turnStartedAt)}`)
  }
  if (timeline.usage) {
    const tokens = timeline.usage.inputTokens + timeline.usage.outputTokens
    const tokenStr = tokens < 1000 ? `${tokens}` : `${(Math.round(tokens / 100) / 10).toFixed(1)}k`
    segments.push(`消耗 ${tokenStr} tokens`)
    if (timeline.usage.cost != null) {
      segments.push(`费用 ≈${Number(timeline.usage.cost.toPrecision(3))}`)
    }
  }
  return segments.length > 0 ? segments.join(' · ') : null
}

/** 历史重放：有序 executionEvents 直接回放（设计 §5-P1 双源接入·历史）。
 *
 * P2-3：落库事件带 `seq`（1 起单调）时**先按 seq 稳定排序**再回放——数组下标本就是序，
 * 但 seq 能在「数组被裁剪/合并/跨消息拼接」后仍还原真实发生顺序；老消息无 seq 则维持原序（兼容不破）。
 */
export function replayTimelineEvents(
  events: Array<{ type: string; data: unknown; seq?: number }>,
  bodyText?: string,
): TurnTimeline {
  const ordered = events.every((e) => typeof e.seq === 'number')
    ? [...events].sort((a, b) => (a.seq as number) - (b.seq as number))
    : events
  const timeline = createTurnTimeline()
  for (const event of ordered) {
    applyTimelineEvent(timeline, event as TimelineEvent)
  }
  // 历史无 text_delta：若没有任何文本块但有消息正文，补一个 done 文本块（避免时间线缺失正文）
  if (!timeline.parts.some((p) => p.kind === 'text') && bodyText && bodyText.trim()) {
    timeline.parts.unshift({
      kind: 'text',
      id: nextPartId('text'),
      text: bodyText,
      status: 'done',
    })
  }
  finalizeTurnTimeline(timeline)
  return timeline
}
