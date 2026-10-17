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

export type ThinkingPart = {
  kind: 'thinking'
  id: string
  text: string
  status: 'running' | 'done'
  startedAt: number
  endedAt?: number
}

export type TimelinePart =
  | ThinkingPart
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
      /**
       * 产物媒体地址（2026-10-17 晚到回填）：node_status 事件可携带、渲染层缩略图**优先**
       * 用它，resolveNodeUrl（画布节点查找）只作兜底 —— 回合流关闭后完成的生成，
       * 画布节点可能尚未同步/已换页，直存 url 才能让缩略图稳定出现。
       */
      url?: string
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
  /** Q2（2026-10-14）：estimatedCredits = 服务端预估积分（MarginPolicy+FX 折算，纯展示）。 */
  usage?: TimelineUsage
  /**
   * 2026-10-14（生产实证）：上游 thinking done 事件曾以**累积快照**下发（每段带此前
   * 全部段全文，4 段 len 220/758/822/963 同 head）。服务端已修（accumulator 段间重置），
   * 但**存量落库事件仍是累积形态**，且前端必须对两种形态都鲁棒：
   * 记录上一条原始 summary，新 summary 以其为前缀 ⇒ 差分出本段增量；否则视为段增量原文。
   * 仅存在于内存模型（replay 每次重建），不落库。
   */
  lastRawThinking?: string
}

export type TimelineUsage = {
  inputTokens: number
  outputTokens: number
  /** P2 T5：cache 三列分开（inputTokens = 纯 input）；旧落库事件无 cache 字段 → 键不出现。 */
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
  estimatedCredits?: number
}

export type TimelineEvent =
  | { type: 'text_delta'; data: { text: string } }
  | {
      /** 落库正文段（2026-10-14）：服务端把两次非文本事件之间的 delta 折叠为一段 text，
       *  重放时按 seq 归位 —— 修「正文整体前置、时序倒挂」。仅出现在历史 executionEvents。 */
      type: 'text'
      data: { text: string }
    }
  | { type: 'thinking'; data: { status: string; summary?: string } }
  | { type: 'tool_call'; data: { toolCallId?: string; name: string; args?: unknown } }
  | {
      type: 'tool_result'
      data: { toolCallId?: string; name: string; result?: unknown; isError?: boolean }
    }
  | { type: 'canvas_action'; data: CanvasAction }
  | { type: 'node_status'; data: { nodeId: string; status: string; url?: string } }
  | { type: 'turn_usage'; data: TimelineUsage & { estimatedCredits?: number } }
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
/**
 * part id **必须稳定**（2026-10-14）。
 *
 * 曾经带 `Date.now()`，导致 `replayTimelineEvents` 重跑或 liveTimeline 刷新后
 * 每个 part 的 `:key` 都变 ⇒ `<details>` 等元素被卸载重挂 ⇒ 折叠/展开状态、
 * 动画状态、滚动锚点、增量 DOM patch 全部丢失（思考块「点开收不回」的路径 A）。
 *
 * 稳定 key 是上述所有能力的**共同前提**，不应由时间戳决定。
 * 计数器 + 模块级唯一性已足够：同一 timeline 内绝不重号，replay 重建时天然是同一套序号。
 */
function nextPartId(prefix: string): string {
  partCounter += 1
  return `${prefix}-${partCounter}`
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

/**
 * 收口正在 streaming 的文本块（Fix 1+2）。
 *
 * 服务端 `createTextSegmentPersister` 的边界定义是「两次非文本事件之间的 delta 连续流」，
 * 且每次非文本事件前都会 `flush()`。客户端 live 路径此前从不收口 ⇒ 多段叙述全堆进第一块
 * 文本、工具被压到下方（时序倒挂 / 正文整体前置）。此处镜像同语义：任意非文本事件到达即
 * 把当前 streaming 文本块翻 `done`，使后续 `text_delta` 另起一段、按真实发生位置归位。
 */
function closeOpenTextBlock(timeline: TurnTimeline): void {
  const part = [...timeline.parts].reverse().find(
    (p): p is Extract<TimelinePart, { kind: 'text' }> =>
      p.kind === 'text' && p.status === 'streaming',
  )
  if (part) part.status = 'done'
}

export function applyTimelineEvent(timeline: TurnTimeline, event: TimelineEvent): void {
  // 非文本事件 ⇒ 先收口正在 streaming 的文本段（服务端 flush 同语义），保证文本按真实
  // 发生位置分段、与工具/思考交错顺序一致。文本类事件（text_delta/text/text_replace）与
  // 回合边界（message_start/message_end，由 finalizeTurnTimeline 收口）不触发。
  if (
    event.type !== 'text_delta' &&
    event.type !== 'text' &&
    event.type !== 'text_replace' &&
    event.type !== 'message_start' &&
    event.type !== 'message_end'
  ) {
    closeOpenTextBlock(timeline)
  }
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
    case 'text': {
      // 落库正文段：按发生位置插入 done 文本块（段 = 两次非文本事件之间的连续 delta）。
      // 服务端已按边界切好段，这里直接落块；空段防御性跳过。
      const text = String(event.data.text ?? '')
      if (!text.trim()) return
      timeline.parts.push({ kind: 'text', id: nextPartId('text'), text, status: 'done' })
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
      // 终态：落到最近一段 running 思考；否则最后一段 thinking；都没有则新建 done 段。
      // 2026-10-14：done.summary 可能是**累积快照**（含此前段全文，存量落库数据），
      // 与 lastRawThinking 前缀比对差分出本段增量；无前缀关系则视为段增量原文（服务端
      // 已修为段间重置后的新形态）。差分为空且段内无文本时不留空思考块。
      const raw = d.summary ?? ''
      let delta = raw
      const lastRaw = timeline.lastRawThinking
      if (lastRaw && raw.startsWith(lastRaw) && raw.length > lastRaw.length) {
        delta = raw.slice(lastRaw.length)
      }
      timeline.lastRawThinking = raw
      let target: Extract<TimelinePart, { kind: 'thinking' }> | undefined
      let targetIdx = -1
      for (let i = timeline.parts.length - 1; i >= 0; i -= 1) {
        const p = timeline.parts[i]
        if (p.kind !== 'thinking') continue
        if (p.status === 'running') {
          target = p
          targetIdx = i
          break
        }
        if (!target) {
          target = p
          targetIdx = i
        }
      }
      if (target) {
        // Q1（2026-10-14 流式思考）：running 期间已透传累积快照（server 节流，快照是
        // done 全文的前缀）。此时直接以 done 全文**权威替换**；否则（存量无流式数据）
        // 保持差分追加语义。判据 = 目标块当时还是 running 且已带快照文本。
        const wasStreaming = target.status === 'running'
        target.status = 'done'
        if (delta) {
          if (wasStreaming && target.text && raw.startsWith(target.text)) {
            target.text = raw
          } else {
            target.text = target.text ? `${target.text}${delta}` : delta
          }
        }
        target.endedAt = Date.now()
        if (!target.text) timeline.parts.splice(targetIdx, 1)
      } else if (delta) {
        timeline.parts.push({
          kind: 'thinking',
          id: nextPartId('thinking'),
          text: delta,
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
      // ── TURN-IDENTITY PR3（孤儿降级）──
      // 没有前置 `tool_call` 的 `tool_result` = **本流从半路接入**（订阅切片 / 断线
      // 重连 / 老落库数据缺头）。此前这里 `parts.push` 一条工具行 ⇒ 它成为 `parts[0]`
      // ⇒ 「提议生成」卡片顶到思考和工具消息之前（生产漂移事故的直接成因）。
      //
      // 正确做法不是「想办法排到后面」（排序修不好：它是**缺失**，不是错位），
      // 而是**如实说缺**：出一条 notice，不伪造工具行（N4：不冒充全量）。
      const orphanNoticeId = `notice:orphan-tool:${d.toolCallId ?? name}`
      if (!timeline.parts.some((p) => p.kind === 'notice' && p.id === orphanNoticeId)) {
        timeline.parts.push({
          kind: 'notice',
          id: orphanNoticeId,
          text: '本轮前半段事件未捕获（中途接入/历史缺失）',
          tone: 'info',
        })
      }
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
      // url 语义分叉：非 failed 态 = 媒体地址（直存 part.url）；failed 态沿用既有语义
      // （url 兼作错误文案，见下方 errorText）——回填方对 failed 只传错误语义或不传。
      const mediaUrl =
        d.status !== 'failed' && typeof d.url === 'string' && d.url ? d.url : undefined
      const existing = timeline.parts.find(
        (p): p is Extract<TimelinePart, { kind: 'artifact' }> =>
          p.kind === 'artifact' && p.nodeId === d.nodeId,
      )
      if (existing) {
        existing.status = status
        if (mediaUrl) existing.url = mediaUrl
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
        url: mediaUrl,
        errorText: d.status === 'failed' ? '生成失败，可重试' : undefined,
      })
      return
    }
    case 'turn_usage': {
      const u = event.data
      timeline.usage = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        ...(typeof u.cacheReadTokens === 'number' && Number.isFinite(u.cacheReadTokens)
          ? { cacheReadTokens: u.cacheReadTokens }
          : {}),
        ...(typeof u.cacheWriteTokens === 'number' && Number.isFinite(u.cacheWriteTokens)
          ? { cacheWriteTokens: u.cacheWriteTokens }
          : {}),
        ...(typeof u.cost === 'number' && Number.isFinite(u.cost) ? { cost: u.cost } : {}),
        ...(typeof (u as { estimatedCredits?: number }).estimatedCredits === 'number' &&
        Number.isFinite((u as { estimatedCredits?: number }).estimatedCredits)
          ? { estimatedCredits: (u as { estimatedCredits?: number }).estimatedCredits }
          : {}),
      }
      return
    }
    case 'waiting_user': {
      // 2026-10-17（恢复可见化，双粒度）：等待态在时间线里恢复**单条 upsert** notice——
      // 本 notice 回答「对话流为什么空了/在等什么」（原因），倒计时仍只在 dock 状态行
      // （turnStatusBar waitHint「还剩 N 分钟自动取消」）⇒ 两处文案不重复、各司其职。
      // 历史：10-14 曾因「等待你在画布上确认生成 重复」整体下线本 notice（D3 一处渲染），
      // 但状态行在 composer 角上，用户盯消息流时那 ~300s 阻塞期形同「死了」（生产投诉）。
      // 单条 upsert（稳定 id；resolved 只改文案、不新增不删除）既复现可见性，又不重犯重复。
      const d = event.data
      const waitingNoticeId = 'notice:waiting'
      const findWaitingNotice = () =>
        timeline.parts.find(
          (p): p is Extract<TimelinePart, { kind: 'notice' }> =>
            p.kind === 'notice' && p.id === waitingNoticeId,
        )
      if (d.status === 'resolved') {
        // 解除：同一条改文案（⏸→·），留着说明「刚才那段空白在等什么」
        const existing = findWaitingNotice()
        if (existing) {
          existing.text = '已继续执行'
          existing.tone = 'info'
        }
        return
      }
      const text =
        d.toolName === 'propose_generation'
          ? '等待你在画布上确认生成，确认后继续输出'
          : d.reason
            ? `等待你确认：${d.reason}`
            : '等待你确认后继续'
      const existing = findWaitingNotice()
      if (existing) {
        // 等待事件重复到达（重放/多段等待）只改文案，绝不追加第二条（10-14 反馈不回归）
        existing.text = text
        existing.tone = 'warn'
        return
      }
      timeline.parts.push({ kind: 'notice', id: waitingNoticeId, text, tone: 'warn' })
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
  data: { nodeId: string; nodeType: string; title: string; status: 'pending' | 'running' | 'done' | 'failed'; errorText?: string; url?: string },
): void {
  const existing = timeline.parts.find(
    (p): p is Extract<TimelinePart, { kind: 'artifact' }> =>
      p.kind === 'artifact' && p.nodeId === data.nodeId,
  )
  if (existing) {
    existing.status = data.status
    if (data.url) existing.url = data.url
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
    url: data.url,
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
    // 稳定 id（2026-10-17）：晚到回填（refreshTimelineSummary）要能**按 id 精确找到**
    // 这条摘要 notice 原地刷新文案。与孤儿降级（notice:orphan-tool:*）、partial 围栏
    // （notice:partial-ledger）、等待（notice:waiting）同属冒号式稳定 id 家族，
    // 与 nextPartId 计数式 id 区分开。
    timeline.parts.push({
      kind: 'notice',
      id: 'notice:turn-summary',
      text: summary,
      tone: 'info',
    })
  }
}

/**
 * 晚到回填后的摘要刷新（2026-10-17 产物体验补全）。
 *
 * finalizeTurnTimeline 在回合收束时把摘要 notice 追加在末尾，其统计是**当时的快照**——
 * 「生成晚于回合收束完成」时（异步图片/视频常见），artifact 事后才翻 done，
 * 「已生成 N 个产物」会少计。轮询回填终态后调用本函数按稳定 id 找到摘要 notice
 * 原地重算文案；未收束（无 turnEndedAt）或摘要 notice 不存在时静默跳过。
 */
export function refreshTimelineSummary(timeline: TurnTimeline): void {
  if (timeline.turnEndedAt == null) return
  const summaryNotice = timeline.parts.find(
    (p): p is Extract<TimelinePart, { kind: 'notice' }> =>
      p.kind === 'notice' && p.id === 'notice:turn-summary',
  )
  if (!summaryNotice) return
  const summary = summarizeTimeline(timeline)
  if (summary) summaryNotice.text = summary
}

/** 摘要文案（复用 turnSummaryLine 的口径，但数据源是 parts）。 */
export function summarizeTimeline(timeline: TurnTimeline): string | null {
  // 产物口径（2026-10-17 用户裁定）：只统计**生成的内容**（done 的 artifact part =
  // 文本/图片/视频/音频节点）。连线/移除/视口/explore 等画布过程动作是「过程」不是
  // 「产物」——旧口径把 canvas part 一并计入，一条连线会被算成「已创建 1 个节点」。
  const productCount = timeline.parts.filter(
    (p) => p.kind === 'artifact' && p.status === 'done',
  ).length
  const proposeSteps = timeline.parts.filter(
    (p) => p.kind === 'tool' && p.toolName === 'propose_generation',
  )
  const imageCount = proposeSteps.length
  const segments: string[] = []
  if (productCount > 0) segments.push(`已生成 ${productCount} 个产物`)
  if (imageCount > 0) segments.push(`提议生成 ${imageCount} 张`)
  if (timeline.turnEndedAt != null) {
    segments.push(`用时 ${formatDuration(timeline.turnEndedAt - timeline.turnStartedAt)}`)
  }
  if (timeline.usage) {
    // P2 T5：inputTokens 已收窄为纯 input，合计 = in + cacheRead + cacheWrite + out
    // （旧事件无 cache 字段 → 0 兜底），用户可见总量不缩水。
    const tokens =
      timeline.usage.inputTokens +
      (timeline.usage.cacheReadTokens ?? 0) +
      (timeline.usage.cacheWriteTokens ?? 0) +
      timeline.usage.outputTokens
    const tokenStr = tokens < 1000 ? `${tokens}` : `${(Math.round(tokens / 100) / 10).toFixed(1)}k`
    segments.push(`消耗 ${tokenStr} tokens`)
    // Q2（2026-10-14）：摘要把消耗收敛到**积分**单一口径（与项目计费体系一致）——
    // USD cost 是上游内部成本口径，不再透出给用户；预估积分缺（渠道未配 pricing /
    // MarginPolicy 不可用）时只显示 tokens，绝不显示 0 积分假象。
    const credits = timeline.usage.estimatedCredits
    if (typeof credits === 'number' && Number.isFinite(credits) && credits > 0) {
      segments.push(`≈${Math.ceil(credits)} 积分（预估）`)
    }
  }
  return segments.length > 0 ? segments.join(' · ') : null
}

/** 历史重放：有序 executionEvents 直接回放（设计 §5-P1 双源接入·历史）。
 *
 * P2-3：落库事件带 `seq`（1 起单调）时**先按 seq 稳定排序**再回放——数组下标本就是序，
 * 但 seq 能在「数组被裁剪/合并/跨消息拼接」后仍还原真实发生顺序；老消息无 seq 则维持原序（兼容不破）。
 *
 * TURN-IDENTITY P0-1：排序键改 **gSeq 优先**。
 * ⚠️ 局部 `seq` 是 Nest **每条流各自从 1 起**的计数——同一 run 的订阅切片里它也是 1..N，
 * 于是「切片顺序看着单调、实则错误」：这正是孤儿 `tool_result` 能把「提议生成」卡片
 * 伪装成合法顺序、顶在思考和工具消息之前的机理。`gSeq` 是 pi-runtime 的会话级全局序号，
 * 与 `afterSeq` 同编号空间，跨流可比。存量消息无 `gSeq` ⇒ 回退 `seq`，兼容不破。
 */
export function replayTimelineEvents(
  events: Array<{ type: string; data: unknown; seq?: number; gSeq?: number }>,
  bodyText?: string,
  /**
   * TURN-IDENTITY PR3：`metadata.partial` —— 服务端判定本条账本**不完整**
   * （本流没捕获到 run 起点）。真值 = 因果围栏，不用内容指纹（N5）。
   */
  opts?: { partial?: boolean },
): TurnTimeline {
  const sortKey = (e: { seq?: number; gSeq?: number }): number => (e.gSeq ?? e.seq) as number
  const ordered = events.every((e) => typeof sortKey(e) === 'number')
    ? [...events].sort((a, b) => sortKey(a) - sortKey(b))
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
  if (opts?.partial) {
    // 缺口标注置顶：让用户第一眼就知道「这一轮的前半段不在库里」，
    // 而不是看到一条没头没尾的工具结果以为是完整过程。
    timeline.parts.unshift({
      kind: 'notice',
      id: 'notice:partial-ledger',
      text: '本轮前半段事件未捕获（中途接入）',
      tone: 'info',
    })
  }
  finalizeTurnTimeline(timeline)
  return timeline
}
