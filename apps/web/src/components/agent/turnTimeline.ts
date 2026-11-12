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
import { resolveModelDisplayName } from '@/utils/model-display'
import {
  canvasActionLabel,
  formatDuration,
} from '@/components/agent/executionStepLabels'

/** ask_user 题面单项（与 `ask_user` 事件 data.questions 形态完全一致）。 */
export type QuestionItem = {
  id: string
  question: string
  options: { label: string; value: string }[]
  multiSelect?: boolean
  allowOther?: boolean
  plan?: { summary: string; explanation?: string; steps: { content: string; activeForm?: string }[] }
}

/**
 * W1c（D1=A）：服务端 `interruption` 摘要（PendingInterruption 表最新一条，不限 status）。
 * 前端用它刷新 / 重连后重建 ask_user 卡，与 `pendingInterruption`（仅活门）独立并存。
 */
export type InterruptionSummary = {
  callId: string
  kind: string
  questions: unknown[]
  expiresAt: number
  status: 'pending' | 'answered' | 'expired' | 'aborted'
}

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
      status: 'running' | 'done' | 'failed' | 'interrupted'
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
      /**
       * 生成等待进度（2026-10-18 上游对齐）：generation_progress 事件携带的已等待时长，
       * 仅 running 态渲染「生成中 · X」；不落库（executionEvents 白名单不含），刷新后由
       * 下一拍进度事件重建。单调不减（旧拍晚到不回退）。
       */
      progressElapsedMs?: number
    }
  | {
      kind: 'notice'
      id: string
      text: string
      tone: 'info' | 'warn' | 'error'
      /** D2：error notice 携带重试入口文案（由渲染层出按钮）。 */
      retryLabel?: string
      /**
       * 点⑤（2026-11-04 tokens 移详情）：摘要详情态文本，悬停承载（原生 title）。
       * 当前承载 tokens breakdown（与 executionTrace T7 口径一致）；主行只留积分。
       */
      detail?: string
    }
  /**
   * 等待态单一真相（2026-10-28 根治规格）：propose_generation 的「等用户在画布上确认」
   * 不再用 `blockingWait`/`proposePendingConfirm` 两套 store 态 + 对话流外浮卡各自表达，
   * 而是时间线里的一个内联 part——对话流（live dock + 历史气泡同源）、画布节点浮层、
   * 底部状态行都只读它。一个 `waiting_user{status:'waiting'}` 事件只 upsert 这一个 part。
   */
  | {
      kind: 'proposal'
      id: string
      toolName: 'propose_generation'
      nodeId?: string
      title: string
      status: 'pending_confirm' | 'confirmed' | 'declined' | 'expired'
      callId?: string
      timeoutMs?: number
      startedAt: number
    }
  /**
   * P1-2（spec 2026-11-11-propose-plan-visibility-design.md D4）：方案一等公民 part。
   * 由 `plan_proposed` 事件派生（live SSE 与 executionEvents 重放同源）——确认卡
   * （question part 内联 plan，P0-2）是决策面，本 part 是方案本体在对话流的**持久存档**：
   * 卡被回答/超时后仍可见，也是二期方案面板（spec §12）的数据底座。
   * 每 callId 一个 part（refine 后再提案 = 对话流独立一步，不 upsert）。
   */
  | {
      kind: 'plan'
      id: string
      callId?: string
      summary: string
      explanation?: string
      steps: Array<{ content: string; activeForm?: string }>
      status: 'proposed'
      startedAt: number
    }
  /**
   * 等待态单一真相（ask_user）：题面 + 选项 + 多选/其他，内联在对话流。
   * 取代组件级 `pendingAskUser` ref，成为 ask 等待的唯一来源。
   * status 含 `expired`（W1c-2）：门已超时/终态但卡未建出时，由服务端 state 权威翻终态。
   */
  | {
      kind: 'question'
      id: string
      callId?: string
      title: string
      status: 'pending_answer' | 'answered' | 'declined' | 'expired'
      questions: QuestionItem[]
      startedAt: number
    }

export interface TurnTimeline {
  parts: TimelinePart[]
  turnStartedAt: number
  turnEndedAt?: number
  /** Q2（2026-10-14）：estimatedCredits = 服务端预估积分（MarginPolicy+FX 折算，纯展示）。 */
  usage?: TimelineUsage
  /** 2026-11-03 结算摘要：turn_settled 权威值（覆盖摘要行里的「≈N 积分（预估）」段）。 */
  settled?: {
    credits?: number
    model?: string
    degraded?: boolean
    released?: boolean
  }
  /**
   * 2026-10-14（生产实证）：上游 thinking done 事件曾以**累积快照**下发（每段带此前
   * 全部段全文，4 段 len 220/758/822/963 同 head）。服务端已修（accumulator 段间重置），
   * 但**存量落库事件仍是累积形态**，且前端必须对两种形态都鲁棒：
   * 记录上一条原始 summary，新 summary 以其为前缀 ⇒ 差分出本段增量；否则视为段增量原文。
   * 仅存在于内存模型（replay 每次重建），不落库。
   */
  lastRawThinking?: string
  /**
   * 节点创建元数据暂存（2026-11-03 修复）：`add_node` 到达时节点刚建好、还没开始生成，
   * 此时**不急切建 artifact 卡**（否则确认前就露一张与 proposal 重复的「待确认」节点卡，
   * 且确认后产物卡错位顶到「新建节点」前）。只把 nodeType/title 暂存到这里，等用户**确认**
   * （`waiting_user{resolved}` → confirmed）才用此 meta 建卡——卡天然排在
   * proposal 之后，时间线连续可读。内存态，replay 每次重建，不落库（executionEvents 白名单不含）。
   */
  pendingNodeMeta: Record<string, { nodeType: string; title: string }>
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
  | {
      /** 生成等待进度（2026-10-18 上游对齐）：run_* / propose 阻塞期 onUpdate 快照派生，
       *  非持久化、活体显示专用（见 artifact part.progressElapsedMs 注）。 */
      type: 'generation_progress'
      data: { nodeId: string; elapsedMs: number }
    }
  | { type: 'turn_usage'; data: TimelineUsage & { estimatedCredits?: number } }
  | {
      /** 2026-11-03 结算摘要：turn_settled 权威结算进时间线（摘要行「共消耗 N 积分 · 模型名」
       *  数据源）。随 executionEvents 落库重放，键不出现纪律同 applyTurnSettled。 */
      type: 'turn_settled'
      data: {
        holdId: string
        credits?: number
        model?: string
        ruleVersion?: string
        degraded?: boolean
        released?: boolean
      }
    }
  | {
      /**
       * D1（2026-11-11 生产事故 cmwbvfp4p000qrk01pch77w13）：主流自然耗尽且
       * 从未收到 agent_end/error。⚠️ reason 只陈述可观测事实（no_terminal_event），
       * 不臆断 pod 重启 / nginx 掐断 / 客户端断网。随 executionEvents 落库重放，
       * 让刷新 / 断连续传后中断态仍在（而非被 finalizeTurnTimeline 翻回 ✓）。
       */
      type: 'turn_interrupted'
      data: {
        reason: 'no_terminal_event'
        runId?: string
        lastSeq?: number
        outstandingToolCallIds?: string[]
      }
    }
  | {
      /**
       * 阻塞态事件（ADR-0011 T8，2026-10-20 协议语义对齐）。
       *
       * 与工具产出（`tool_result` / `canvas_action` / `node_status`）是**两类不同事件**：
       * 本事件表示「内核已把决策权交回 host，正在等用户」，不是一个待渲染的工具结果。
       * 上游等价物是 coding-agent 的 `ui_prompt_start` / `ui_prompt_end`
       * （`vendor/earendil-works/pi/packages/coding-agent/src/core/extensions/types.ts:745-759`），
       * 同一语义角色：**事件化建模「正在等用户」**，而非让 host 从工具结果里推断。
       *
       * ⚠️ 传输层名字保留 `waiting_user`（SSE 契约 + 既有 reducer / 快照均按此名），
       * 只对齐**语义与角色**，不 wire-level 改名——改名要动协议与回放快照，代价大于收益。
       * 上游对照与渲染落点见 docs/superpowers/specs/2026-10-19-propose-confirm-single-surface-design.md §7。
       */
      type: 'waiting_user'
      data: {
        status?: string
        toolName?: string
        nodeId?: string
        reason?: string
        /** 根治规格：确认/取消走 POST /answers 的 callId（propose_generation 由 waiting_user 携带）。 */
        callId?: string
        /** 人话标题，如「提议生成 · 1个节点」。 */
        title?: string
        /** 自动取消倒计时（ms，决策 6）。 */
        timeoutMs?: number
      }
    }
  | {
      /** ask_user 题面（根治规格）：从 `canvas_command{type:'ask_user'}` 收敛进时间线单一真相。 */
      type: 'ask_user'
      data: {
        callId?: string
        title?: string
        questions: Array<{
          id: string
          question: string
          options: { label: string; value: string }[]
          multiSelect?: boolean
          allowOther?: boolean
          /** P0-2（spec 2026-11-11）：propose_plan 确认卡内联方案（运行时透传；类型补齐于 P1-2）。 */
          plan?: { summary: string; explanation?: string; steps: { content: string; activeForm?: string }[] }
        }>
      }
    }
  | {
      /** P1-2（spec 2026-11-11 D4）：plan_proposed 一等方案事件。server
       *  pi-events.extractPlanProposedEvent 从 propose_plan 的 details.plan 派生，
       *  随 executionEvents 落库 ⇒ 刷新/重连后方案仍可见（live 与重放同一 case 消费）。 */
      type: 'plan_proposed'
      data: {
        callId?: string
        summary: string
        explanation?: string
        steps: Array<{ content: string; activeForm?: string }>
      }
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
    /** 节点创建元数据暂存（2026-11-03 修复）：add_node 只记 meta，node_status 进入生成生命周期才建卡。 */
    pendingNodeMeta: {},
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

/**
 * waiting_user{resolved} 的 reason → proposal part 终态（2026-10-31 大章鱼回合实证）。
 * 缺省回落 confirmed：与既有行为一致（老事件无 reason 时不回退）。
 */
function resolveProposalStatusByReason(
  reason?: string,
): 'confirmed' | 'declined' | 'expired' {
  if (reason === 'aborted') return 'declined'
  if (reason === 'timeout') return 'expired'
  return 'confirmed'
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
              p.kind === 'tool' && p.toolName === name &&
              (p.status === 'running' || p.status === 'interrupted'),
          )
      const resultSummary = summarizeToolResult(d.result)
      if (existing) {
        existing.status = d.isError ? 'failed' : 'done'
        existing.isError = d.isError === true
        if (resultSummary) existing.resultSummary = resultSummary
        // D1 可恢复：followUp tail 续传的结果把最后一条未配对工具补齐后，
        // 中断 notice 不再成立 ⇒ 原地移除（避免界面继续说「未交付」）。
        const stillPending = timeline.parts.some(
          (p) => p.kind === 'tool' && (p.status === 'running' || p.status === 'interrupted'),
        )
        if (!stillPending) {
          const idx = timeline.parts.findIndex(
            (p) => p.kind === 'notice' && p.id === 'notice:turn-interrupted',
          )
          if (idx >= 0) timeline.parts.splice(idx, 1)
        }
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
        // 2026-11-03 修复：不再急切建 pending 态 artifact（会造成「确认前就出现待确认节点卡」
        // 且与 proposal 卡重复、确认后产物卡错位顶到「新建节点」前）。只暂存 meta，待
        // 用户**确认**（waiting_user resolved→confirmed）才真正建卡——此时卡天然排在 proposal 之后。
        // （2026-11-04 修正：此前写「待 node_status 进入生成生命周期才建卡」，但 node_status 无服务端
        // 生产者、且画布对账只回填已存在的卡 ⇒ 卡永不出现；建卡时机改到确认点，见 waiting_user 分支。）
        const nodeType = String(action.payload?.nodeType || 'image')
        // title/prompt 都在 payload.data 里（CanvasAction 无顶层 title，见 deriveLinkedOutputs）
        const title = String(
          action.payload?.data?.title || action.payload?.data?.prompt || '未命名',
        ).slice(0, 20)
        timeline.pendingNodeMeta[String(nodeId)] = { nodeType, title }
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
      // 兜底：确认点已建卡（见 waiting_user resolved→confirmed），此处通常只更新既有卡。
      // 若 node_status 早于确认到达（罕见），用暂存 meta 建卡，标题不退化成「未命名」。
      const meta = timeline.pendingNodeMeta[d.nodeId]
      timeline.parts.push({
        kind: 'artifact',
        id: nextPartId('artifact'),
        nodeId: d.nodeId,
        nodeType: meta?.nodeType ?? 'image',
        title: meta?.title ?? '未命名',
        status,
        url: mediaUrl,
        errorText:
          d.status === 'failed'
            ? typeof d.url === 'string' && d.url
              ? d.url
              : '生成失败，可重试'
            : undefined,
      })
      return
    }
    case 'generation_progress': {
      // 生成等待进度（2026-10-18 上游对齐）：只活体显示，不落库（刷新后由下一拍重建）。
      // 单调不减：SSE 重连补发/乱序时旧拍不得回退新拍。终态（node_status done/failed）
      // 后到达的进度拍自然失效（part.status 非 running 不渲染）。
      const d = event.data
      const part = timeline.parts.find(
        (p): p is Extract<TimelinePart, { kind: 'artifact' }> =>
          p.kind === 'artifact' && p.nodeId === d.nodeId,
      )
      if (!part || part.status !== 'running') return
      if (typeof d.elapsedMs !== 'number' || !Number.isFinite(d.elapsedMs) || d.elapsedMs < 0) return
      part.progressElapsedMs = Math.max(part.progressElapsedMs ?? 0, Math.round(d.elapsedMs))
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
    case 'turn_settled': {
      // 2026-11-03 结算摘要：权威结算写 timeline.settled（覆盖写、重放幂等），摘要 notice
      // 若已存在（回合先收束、结算晚到——常态）则原地刷新文案。
      const d = event.data
      timeline.settled = {
        ...(typeof d.credits === 'number' && Number.isFinite(d.credits) ? { credits: d.credits } : {}),
        ...(typeof d.model === 'string' && d.model ? { model: d.model } : {}),
        ...(d.degraded === true ? { degraded: true } : {}),
        ...(d.released === true ? { released: true } : {}),
      }
      refreshTimelineSummary(timeline)
      return
    }
    case 'waiting_user': {
      // 2026-10-28 根治：等待态单一真相 = 时间线 part。
      // propose_generation ⇒ upsert 一个 `proposal` part（pending_confirm）；ask 等 ⇒ 保留
      // `notice:waiting` 兜底（question part 由 ask_user 事件另建）。resolved ⇒ 把匹配的
      // proposal/question part 翻终态，并把旧 notice 翻「已继续执行」，绝不新增/删除（保位）。
      const d = event.data
      if (d.status === 'resolved') {
        // 2026-10-31 大章鱼回合生产实证（cmvvaw8ar000moe01fdolrugb）：resolved 必须按
        // reason 映射终态——此前一律翻 confirmed，「用户点了取消」的卡也显示「已确认」，
        // 展示层撒谎（v-else 分支把 declined/expired 全渲染成已确认）。
        // reason 语义（pending-registry PendingResolution）：answered=确认 / aborted=中止
        // （显式取消或批注锚带回）/ timeout=超时自动取消。
        const prop = timeline.parts.find(
          (p): p is Extract<TimelinePart, { kind: 'proposal' }> =>
            p.kind === 'proposal' && (!d.callId || !p.callId || p.callId === d.callId),
        )
        if (prop) {
          const resolved = resolveProposalStatusByReason(d.reason)
          prop.status = resolved
          // 2026-11-04 修复：确认（answered）即启动生成 ⇒ 此刻建出 artifact 产物卡。
          // 此前 deferred 到 node_status，但 node_status 无服务端生产者、且画布对账
          // （reconcileFromNodes）只回填「时间线已持有」的卡 ⇒ 卡永不出现、产物永不落库。
          // 建卡时机改到「确认」：同回合 add_node 已把 nodeType/title 暂存进 pendingNodeMeta，
          // 此刻取来建卡；卡天然排在 proposal 之后（parts 顺序 = 事件到达顺序）。建出后
          // `owned` 非空 ⇒ 对账/轮询正常把它翻到 generating/done。幂等：已存在不重复建；
          // 取消/超时（非 confirmed）不建卡。
          if (
            resolved === 'confirmed' &&
            prop.nodeId &&
            !timeline.parts.some(
              (p) => p.kind === 'artifact' && p.nodeId === prop.nodeId,
            )
          ) {
            const meta = timeline.pendingNodeMeta[prop.nodeId]
            upsertArtifact(timeline, {
              nodeId: prop.nodeId,
              nodeType: meta?.nodeType ?? 'image',
              title: meta?.title ?? '未命名',
              status: 'running',
            })
          }
        }
        // ⭐ P3（fix/observer-refusal-exempt）：resolved 必须按 callId 精确翻匹配的 question
        // part，与上方 proposal 的 680 行三态条件保持一致。否则多张 ask_user 卡（如生产
        // cmw7kmv3x01q4r401i7ir33b4 出现 4 张）会被一律翻成第一张，其余卡停留 pending_answer
        // 误显。callId 缺失（legacy）回落首张以兼容。
        const q = timeline.parts.find(
          (p): p is Extract<TimelinePart, { kind: 'question' }> =>
            p.kind === 'question' && (!d.callId || !p.callId || p.callId === d.callId),
        )
        if (q) q.status = 'answered'
        const notice = timeline.parts.find(
          (p): p is Extract<TimelinePart, { kind: 'notice' }> =>
            p.kind === 'notice' && p.id === 'notice:waiting',
        )
        if (notice) {
          notice.text = '已继续执行'
          notice.tone = 'info'
        }
        return
      }
      if (d.toolName === 'propose_generation') {
        // 单一 upsert：稳定 id 由 callId/nodeId 决定，重复到达只更新不追加。
        const pid = `proposal:${d.callId ?? d.nodeId ?? 'waiting'}`
        const existing = timeline.parts.find(
          (p): p is Extract<TimelinePart, { kind: 'proposal' }> =>
            p.kind === 'proposal' && p.id === pid,
        )
        if (existing) {
          existing.status = 'pending_confirm'
          existing.nodeId = d.nodeId
          existing.title = d.title ?? existing.title
          existing.callId = d.callId
          existing.timeoutMs = d.timeoutMs
        } else {
          timeline.parts.push({
            kind: 'proposal',
            id: pid,
            toolName: 'propose_generation',
            nodeId: d.nodeId,
            title: d.title ?? '提议生成',
            status: 'pending_confirm',
            callId: d.callId,
            timeoutMs: d.timeoutMs,
            startedAt: Date.now(),
          })
        }
        // 不再另推 notice：proposal part 自带「等待你在画布上确认生成」文案 + 操作按钮
        // （见 AgentTurnTimeline.vue），根治「对话流之外浮卡 + 状态条双源」。
        return
      }
      // 非 propose 的等待（ask 等，无 proposal/question part）：保留 notice 兜底。
      const waitingNoticeId = 'notice:waiting'
      const text = d.reason ? `等待你确认：${d.reason}` : '等待你确认后继续'
      const existingNotice = timeline.parts.find(
        (p): p is Extract<TimelinePart, { kind: 'notice' }> =>
          p.kind === 'notice' && p.id === waitingNoticeId,
      )
      if (existingNotice) {
        existingNotice.text = text
        existingNotice.tone = 'warn'
      } else {
        timeline.parts.push({ kind: 'notice', id: waitingNoticeId, text, tone: 'warn' })
      }
      return
    }
    case 'plan_proposed': {
      // P1-2：方案 part——每 callId 一个，不 upsert（refine 后再提案是对话流独立一步）。
      // live 与 executionEvents 重放共用本 case（replayTimelineEvents 全量喂 applyTimelineEvent）。
      const d = event.data
      timeline.parts.push({
        kind: 'plan',
        id: d.callId ? `plan:${d.callId}` : nextPartId('plan'),
        ...(d.callId ? { callId: d.callId } : {}),
        summary: d.summary,
        ...(d.explanation ? { explanation: d.explanation } : {}),
        steps: d.steps,
        status: 'proposed',
        startedAt: Date.now(),
      })
      return
    }
    case 'ask_user': {
      // 根治规格：ask_user 题面收敛进时间线单一真相，取代组件级 pendingAskUser ref。
      const d = event.data
      const qid = `question:${d.callId ?? 'ask'}`
      const existing = timeline.parts.find(
        (p): p is Extract<TimelinePart, { kind: 'question' }> =>
          p.kind === 'question' && p.id === qid,
      )
      if (existing) {
        existing.status = 'pending_answer'
        existing.callId = d.callId
        existing.title = d.title ?? existing.title
        existing.questions = d.questions
      } else {
        timeline.parts.push({
          kind: 'question',
          id: qid,
          callId: d.callId,
          title: d.title ?? '需要你回答',
          status: 'pending_answer',
          questions: d.questions,
          startedAt: Date.now(),
        })
      }
      return
    }
    case 'turn_interrupted': {
      // D1：上游流耗尽且无权威收束。把「还没回来」的工具从 running 翻成
      // interrupted ⇒ finalizeTurnTimeline 只处理 running，收口时不会翻回 ✓。
      // ⚠️ 不改 finalizeTurnTimeline 签名：实时 SSE / 刷新重放 / 断连续传三条
      // 路径都靠这个落库事件驱动，无需第二套判据。
      for (const p of timeline.parts) {
        if (p.kind === 'tool' && p.status === 'running') p.status = 'interrupted'
      }
      // 稳定 id ⇒ 重放 / 重复下发不叠加（同 notice:partial-ledger 家族）。
      if (!timeline.parts.some((p) => p.kind === 'notice' && p.id === 'notice:turn-interrupted')) {
        const hasSubagent = timeline.parts.some(
          (p) => p.kind === 'tool' && p.toolName === 'spawn_subagent' && p.status === 'interrupted',
        )
        timeline.parts.push({
          kind: 'notice',
          id: 'notice:turn-interrupted',
          // 中性文案：只陈述可观测事实，不臆断「服务更新打断」等无证据归因。
          text:
            '本轮未收到完成确认，结果可能未交付；本次未扣费' +
            (hasSubagent ? ' · 子代理调研没有返回结果' : ''),
          tone: 'error',
          retryLabel: '可重新发送这条消息重试',
        })
      }
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
    // D1：只收口 running。interrupted 由落库 turn_interrupted 事件先一步置位，
    // 此处不翻回 done（否则刷新后界面又把「✓ 0ms」当成成功，二次说谎）。
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
      detail: composeTokensDetail(timeline) ?? undefined,
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
  summaryNotice.detail = composeTokensDetail(timeline) ?? undefined
}

/** tokens 人类化：≥1k 显示 X.Xk（3400 → 3.4k），否则原数。
 *  与 executionTraceReducer.formatTokens 同形（格式化函数，非双表面同文案，C7 不适用）。 */
function formatTokens(total: number): string {
  if (total < 1000) return `${total}`
  return `${(Math.round(total / 100) / 10).toFixed(1)}k`
}

/**
 * 摘要 tokens 详情（点⑤ 2026-11-04：主行只留积分，tokens 收进悬停详情态）。
 *
 * 口径与 executionTrace T7（turnSettledText 结算段）完全对齐：
 * `tokens 输入 X.Xk · 缓存 X.Xk · 输出 X.Xk`——输入 = inputTokens + cacheWriteTokens
 * （计费口径 cacheWrite 并入 in，终审 I-1 / P2 T5 同源），缓存 = cacheReadTokens，
 * 输出 = outputTokens。无 usage 或总量为 0（旧事件/无计费）返回 null ⇒ notice 不挂
 * detail（渲染层无悬停 affordance）。
 */
export function composeTokensDetail(timeline: TurnTimeline): string | null {
  const usage = timeline.usage
  if (!usage) return null
  const input = usage.inputTokens + (usage.cacheWriteTokens ?? 0)
  const cache = usage.cacheReadTokens ?? 0
  const out = usage.outputTokens
  if (input + cache + out <= 0) return null
  return `tokens 输入 ${formatTokens(input)} · 缓存 ${formatTokens(cache)} · 输出 ${formatTokens(out)}`
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
  // C10（规格 §14.5）：单提议单产物（或数量相等）时「已生成 N 个产物 · 提议生成 N 张」
  // 是同一件事说两遍 ⇒ 合并为「已生成 N 张」；数量不等（产物含非提议产物）保留分项。
  if (productCount > 0 && imageCount > 0 && productCount === imageCount) {
    segments.push(`已生成 ${productCount} 张`)
  } else {
    if (productCount > 0) segments.push(`已生成 ${productCount} 个产物`)
    if (imageCount > 0) segments.push(`提议生成 ${imageCount} 张`)
  }
  if (timeline.turnEndedAt != null) {
    segments.push(`用时 ${formatDuration(timeline.turnEndedAt - timeline.turnStartedAt)}`)
  }
  if (timeline.usage) {
    // P2 T5：inputTokens 已收窄为纯 input，合计 = in + cacheRead + cacheWrite + out
    // （旧事件无 cache 字段 → 0 兜底），用户可见总量不缩水。
    // 点⑤（2026-11-04）：tokens 段从主行退场（详情态承载，composeTokensDetail），
    // 主行只留积分；**唯一例外** = Q2 降级路径（无任何积分段，渠道未配 pricing），
    // tokens 是唯一可用口径——维持 Q2「绝不显示 0 积分假象」既有裁定。
    const tokens =
      timeline.usage.inputTokens +
      (timeline.usage.cacheReadTokens ?? 0) +
      (timeline.usage.cacheWriteTokens ?? 0) +
      timeline.usage.outputTokens
    const tokenStr = tokens < 1000 ? `${tokens}` : `${(Math.round(tokens / 100) / 10).toFixed(1)}k`
    // 2026-11-03 结算摘要（对齐 WorkBuddy 回合尾静态行）：settled 到达即用**权威结算值**
    // 收口摘要行，预估段（≈N 积分（预估））不再出现——预估是流式瞬时态，绝不残留为
    // 最终数字。released（预扣全退）不显示负数；credits 缺（异常形态）回退预估段。
    const settled = timeline.settled
    const settledCredits =
      settled && !settled.released && typeof settled.credits === 'number' && Number.isFinite(settled.credits)
        ? settled.credits
        : null
    let creditSegment: string | null = null
    if (settled && settledCredits != null) {
      creditSegment = composeSettledSegment({ credits: settledCredits, model: settled.model, degraded: settled.degraded })
    } else {
      // Q2（2026-10-14）：摘要把消耗收敛到**积分**单一口径（与项目计费体系一致）——
      // USD cost 是上游内部成本口径，不再透出给用户；预估积分缺（渠道未配 pricing /
      // MarginPolicy 不可用）时只显示 tokens，绝不显示 0 积分假象。
      const credits = timeline.usage.estimatedCredits
      if (typeof credits === 'number' && Number.isFinite(credits) && credits > 0) {
        // Epic 3 Task 10（规格 §5.3 flag-off 行）：回合已结束仍无 turn_settled ⇒ 服务端
        // TEXT_TOKEN_BILLING=off（零预扣零结算）——预估段成为终态，必须显式
        // 「预计消耗（非正式结算）」、不冒充已结算；流式中段保持「预估」瞬时态。
        creditSegment =
          timeline.turnEndedAt != null
            ? `预计消耗 ≈${Math.ceil(credits)} 积分（非正式结算）`
            : `≈${Math.ceil(credits)} 积分（预估）`
      }
    }
    if (creditSegment) {
      segments.push(creditSegment)
    } else {
      // Q2 降级：无积分段 ⇒ tokens 保留在主行（唯一可用信息）。
      segments.push(`消耗 ${tokenStr} tokens`)
    }
  }
  return segments.length > 0 ? segments.join(' · ') : null
}

/**
 * 结算段文案（规格 2026-11-03 §14.5-C9 单源）：
 * `已结算 -N 积分（文本[ · 按成本估算][ · 模型展示名]）`。
 *
 * 违规修复背景（生产实例）：旧文案「共消耗 7 积分 · platform::agnes-2.5-flash」两处违规——
 * ① `settled.credits` 只是**文本回合**费，标签「共消耗」把单项口径说成总额，与生成类
 * quote（如图像 33）数字打架；② `settled.model` 原样透出渠道前缀 key。
 * ⇒ C9：主体标注「文本」恒在（credits 是 turn_settled=文本回合权威值）；模型名恒经
 * `resolveModelDisplayName`（目录缺失降级剥前缀裸名）。与 executionTrace `turnSettledText`
 * 同「已结算」词族（C7 双表面口径一致）。生成类费用聚合（「对话 M · 生成 K」）依赖
 * credit_tx 进时间线，列规格 §12 后续包。
 */
export function composeSettledSegment(settled: {
  credits: number
  model?: string
  degraded?: boolean
}): string {
  const name = resolveModelDisplayName(settled.model)
  const tags = ['文本']
  if (settled.degraded) tags.push('按成本估算')
  if (name) tags.push(name)
  const segment = `已结算 -${settled.credits} 积分（${tags.join(' · ')}）`
  // C9 不变量：任何路径都不允许渠道前缀泄漏到用户可见文案（编码纪律：模型名不含 ::）。
  if (segment.includes('::')) {
    throw new Error(`[C9] settled 段泄漏渠道前缀 key：${segment}`)
  }
  return segment
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
/**
 * 历史回放归一化（P0-A，SSE 会话恢复）：服务端落库形态 `canvas_command{type:'ask_user'}`
 * 收敛为时间线原生 `ask_user`，使历史路径与实时路径（trackAskUser → feedTimeline({type:'ask_user'})）
 * 共用同一个 `applyTimelineEvent` 分支，避免确认卡片在历史重放中撞 `default: return` 被吞掉。
 *
 * 仅转换 `ask_user` 子类型；其它 `canvas_command`（set_group_color / focus_node / add_node 等）是
 * 画布侧事件、不在时间线 parts 内，保持原样（撞 default 与现状一致，不引入行为变化）。
 * 服务端至今仍按旧形态落库 `canvas_command`（生产实证：近期会话 `ask_user` 计数全为 0），
 * 故历史路径必须桥接，不能依赖"服务端改发 ask_user"。
 */
function normalizePersistedTimelineEvent(
  e: { type: string; data?: unknown; seq?: number; gSeq?: number },
): { type: string; data?: unknown; seq?: number; gSeq?: number } {
  if (e.type === 'canvas_command') {
    const d = e.data as { type?: string } | undefined
    if (d?.type === 'ask_user') {
      return { type: 'ask_user', data: e.data, seq: e.seq, gSeq: e.gSeq }
    }
  }
  return e
}

/**
 * W1c（D1=A）：用服务端权威 `interruption` 摘要刷新本时间线的 question part。
 *
 * 语义（spec §4 / 计划 §3 Task 3，与 P0 单一真相原则一致）：
 * - summary===null（永无门 / 老会话）⇒ 现有 `pending_answer` 一律翻 `expired`（无权威证据即不可点）；
 *   老会话本就无 question part ⇒ 返回 false（阴性保证，零回归）。
 * - 活门（status==='pending' 且 expiresAt>now）⇒ 保证存在 `pending_answer` 卡（刷新/重连后重建，W1c-1）；
 *   题面以 state 为准补全（仅当 live 事件未带来题面，避免覆盖更丰富题面）。
 * - 终态门（answered/expired/aborted 或已过期）⇒ 翻/建终态卡（W1c-2）：
 *   answered→'answered'、aborted→'declined'、其余（含已过期 pending）→'expired'。
 * - 单门语义：只认 `summary.callId` 这一张，其余 callId 的活卡一律翻 expired（防多卡残留）。
 * - 幂等：同输入二次调用返回 false（首次补建除外）；不新增/删除 part（保位）。
 *
 * @returns 是否发生变更。
 */
export function reconcileTimelineInterruption(
  timeline: TurnTimeline,
  summary: InterruptionSummary | null,
  now = Date.now(),
): boolean {
  const questionParts = timeline.parts.filter(
    (p): p is Extract<TimelinePart, { kind: 'question' }> => p.kind === 'question',
  )
  if (summary === null) {
    let changed = false
    for (const q of questionParts) {
      if (q.status === 'pending_answer') {
        q.status = 'expired'
        changed = true
      }
    }
    return changed
  }
  const isLive = summary.status === 'pending' && summary.expiresAt > now
  const terminalStatus: 'answered' | 'expired' | 'declined' =
    summary.status === 'answered'
      ? 'answered'
      : summary.status === 'aborted'
        ? 'declined'
        : 'expired'
  const qid = `question:${summary.callId}`
  const questions = Array.isArray(summary.questions)
    ? (summary.questions as QuestionItem[])
    : []
  let changed = false
  // 单门语义：其余 callId 的活卡一律翻 expired
  for (const q of questionParts) {
    if (q.id !== qid && q.status === 'pending_answer') {
      q.status = 'expired'
      changed = true
    }
  }
  const existing = questionParts.find((p) => p.id === qid)
  if (existing) {
    const target = isLive ? 'pending_answer' : terminalStatus
    if (existing.status !== target) {
      existing.status = target
      changed = true
    }
    if (isLive && questions.length && (!existing.questions || !existing.questions.length)) {
      existing.questions = questions
      changed = true
    }
    return changed
  }
  // 安全网：state 权威说有这张卡但 replay 没建出（漏帧/历史无该事件）
  timeline.parts.push({
    kind: 'question',
    id: qid,
    callId: summary.callId,
    title: '需要你回答',
    status: isLive ? 'pending_answer' : terminalStatus,
    questions,
    startedAt: now - 1,
  })
  return true
}

export function replayTimelineEvents(
  events: Array<{ type: string; data: unknown; seq?: number; gSeq?: number }>,
  bodyText?: string,
  /**
   * TURN-IDENTITY PR3：`metadata.partial` —— 服务端判定本条账本**不完整**
   * （本流没捕获到 run 起点）。真值 = 因果围栏，不用内容指纹（N5）。
   *
   * D2（multi-device Task 2）：`metadata.truncated` —— 服务端判定本条账本**尾部未捕获**
   * （本流在权威收束事件 agent_end/error 到达之前就结束了；pi 侧那轮仍在跑、仍会跑完）。
   *
   * ⚠️ 两者方向相反、不可混用：`partial` = 头部缺口，`truncated` = 尾部缺口。
   * 两者可同时为真（两头都不齐）⇒ 读端**必须**能分别看出是哪一头缺。
   */
  opts?: { partial?: boolean; truncated?: boolean },
): TurnTimeline {
  const sortKey = (e: { seq?: number; gSeq?: number }): number => (e.gSeq ?? e.seq) as number
  const ordered = events.every((e) => typeof sortKey(e) === 'number')
    ? [...events].sort((a, b) => sortKey(a) - sortKey(b))
    : events
  const timeline = createTurnTimeline()
  for (const event of ordered) {
    applyTimelineEvent(timeline, normalizePersistedTimelineEvent(event) as TimelineEvent)
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
  if (opts?.truncated) {
    // 尾部缺口标注：与上面的头部缺口**分开**标（方向相反，混用会说谎）。
    // 「本轮没看到生成结束」⇒ 用户看到的是前缀，不能当成完整回答。
    timeline.parts.unshift({
      kind: 'notice',
      id: 'notice:truncated-ledger',
      text: '本轮未捕获到生成结束（内容可能不完整）',
      tone: 'info',
    })
  }
  finalizeTurnTimeline(timeline)
  return timeline
}
