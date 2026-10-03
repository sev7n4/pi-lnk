import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  type AgentChatMessage,
  type AgentMessageMetadata,
  type CanvasAction,
  LinkedCanvasOutputSchema,
  type LinkedCanvasOutput,
  type SidebarAttachment,
  validateSidebarAttachments,
} from '@lnkpi/shared'
import { parsePersistedToolCalls } from '@/components/agent/agentCanvasOutputs'
import { summarizeToolArgs } from '@/components/agent/toolArgSummary'
import {
  applyCanvasAction,
  applyExplore,
  applyNodeStatus,
  applyPhaseHint,
  applyStep,
  applyStructuredError,
  applyTaskUpdate,
  applyTextReplaceStage,
  applyThinking,
  applyToolCall,
  applyTurnUsage,
  createExecutionTrace,
  finalizeExecutionTrace,
  replayExecutionTraceEvents,
  replaySvgCardPresentation,
  type ExecutionTraceState,
} from '@/components/agent/executionTraceReducer'
import type { AgentPresentationEnvelope } from '@/components/agent/presentation/types'

export interface AgentStreamMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /**
   * pi 会话内该消息对应的 entry id（来自 `pi_message_end` 事件）。
   * ③ 重跑用：作为 `branchFromEntryId` 让后端 fork 出「截断到本条之前」的新分支线程。
   * 仅 user 消息会带（助手消息的 entryId 无重跑语义）。
   */
  entryId?: string
  toolCalls?: Array<{ name: string; result?: unknown; toolCallId?: string; argsSummary?: string }>
  streaming?: boolean
  textReplaceHistory?: string[]
  executionTrace?: ExecutionTraceState
  presentation?: AgentPresentationEnvelope
  attachments?: SidebarAttachment[]
  attachmentRefKeys?: string[]
  linkedOutputs?: LinkedCanvasOutput[]
  canvasActions?: CanvasAction[]
}

/**
 * 持久化行（后端 AgentMessage 行 → 前端）的真实形状。
 *
 * ⚠️ **不能用交叉类型 `AgentChatMessage & { metadata?: string | null }`**：
 * shared 的 `AgentChatMessage` 已声明 `metadata?: string` 与 `linkedOutputs?: string`，
 * 交叉后再改写这两个属性 ⇒ TS 判定冲突、**整个交叉类型失效**，
 * 于是任何对象都传不进 `loadHistory`（表现为测试里报 TS2322「不兼容」，
 * 但字面量字段其实逐个都对）。
 *
 * 真相是「后端 JSON 字段可能为 null」——这是比shared 声明更宽的运行时事实。
 * 用 Omit 先摘掉原声明再重写，冲突消失，类型恢复可用。
 */
type PersistedAgentMessage = Omit<AgentChatMessage, 'metadata' | 'linkedOutputs'> & {
  linkedOutputs?: string | null
  metadata?: string | null
}

export const useAgentStore = defineStore('agent', () => {
  const messages = ref<AgentStreamMessage[]>([])
  const isStreaming = ref(false)
  /** P1 状态行：本回合 propose_generation 已返回 pending_confirm（waiting 一票通过） */
  const proposePendingConfirm = ref(false)
  /**
   * 阻塞等待中的确认类工具（`waiting_user{status:"waiting"}`，2026-10-01）。
   * 与 proposePendingConfirm 的分工：后者靠 tool_result 反推（阻塞模式下太晚），
   * 本字段由后端在**等待开始**即下发 —— 等待期状态行收口的唯一可靠信号。
   */
  /**
   * `deadlineAt` = 自动取消时刻（waiting_user 的 timeoutMs 起点）。
   * 状态行进二阶（决策 6）：显示「还剩 N 分钟自动取消」，让用户判断要不要先处理。
   */
  const blockingWait = ref<{
    toolName: string
    callId?: string
    nodeId?: string
    /**
     * 阻塞题干（ask_user 经 `waiting_user` 事件的 meta.questionTitle 下发，2026-10-02）。
     * 状态行据此显示「等待你作答：<题面>」，而不是无信息量的「等待你确认」——
     * 用户至少知道在等他答什么。
     */
    question?: string
    deadlineAt?: number
  } | null>(null)
  /**
   * P1「正在做什么」（决策 8）：runtime 在每个工具**起手**时下发的 `activity` 事件载荷。
   *
   * 与 trace 最新一步的分工：trace 走 SSE 的 tool_call/tool_result 反推，长工具期间会停在
   * 上一步的措辞；activity 由 runtime 在起手瞬间下发，状态行能立刻换词。
   * 两者取其一即可，前端「有 activity 就用 activity」—— activity 更实时。
   */
  const activity = ref<{ toolName?: string; done?: number; total?: number } | null>(null)
  /** P1 状态行：最近一次 text_delta 时间戳（waiting 文本静默 ≥2s 判定用） */
  const lastTextDeltaAt = ref(0)
  /** P1 状态行：本回合错误原文（渲染层经 failureReason 映射为人话，禁用 JSON 工具摘要） */
  const turnError = ref<unknown>(null)

  function lastAssistant(): AgentStreamMessage | undefined {
    return [...messages.value].reverse().find((m) => m.role === 'assistant')
  }

  function ensureExecutionTrace() {
    const last = lastAssistant()
    if (!last) return
    if (!last.executionTrace) {
      last.executionTrace = createExecutionTrace()
    }
  }

  function addUserMessage(
    content: string,
    extras?: { attachments?: SidebarAttachment[]; attachmentRefKeys?: string[] },
  ) {
    // 新回合开始：重置回合级状态行信号（propose 置位 / 阻塞等待 / 文本时间戳 / 失败态）
    proposePendingConfirm.value = false
    blockingWait.value = null
    activity.value = null
    lastTextDeltaAt.value = 0
    turnError.value = null
    messages.value.push({
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      attachments: extras?.attachments?.map((attachment) => ({ ...attachment })),
      attachmentRefKeys: extras?.attachmentRefKeys ? [...extras.attachmentRefKeys] : undefined,
    })
  }

  function startAssistantMessage() {
    const msg: AgentStreamMessage = {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: '',
      toolCalls: [],
      streaming: true,
      textReplaceHistory: [],
      executionTrace: createExecutionTrace(),
    }
    messages.value.push(msg)
    return msg
  }

  /**
   * 写当前 assistant 消息的 presentation（spec §4.6 第 2 跳）。
   *
   * ⚠️ `presentation` 是**单值**字段：同一轮 agent 产出两张 svg_card 时**后者覆盖前者**。
   * 这是刻意选择而非疏漏 —— spec §4.6 已定；不引入卡片数组是因为刷新恢复路径
   * （Task 6）只恢复最后一张，落库侧同样没有多卡槽位。
   * 回归锁：`agent.setPresentation.test.ts` 的「同轮第二张卡覆盖第一张」。
   *
   * 无 assistant 消息时静默忽略：与 `appendText` / `addToolCall` 同款兜底，
   * 避免事件竞态（流早于 startAssistantMessage 到达）打断整条流。
   */
  function setPresentation(presentation: AgentPresentationEnvelope) {
    const last = lastAssistant()
    if (!last) return
    last.presentation = presentation
  }

  function appendText(text: string) {
    // text_delta 落点：刷新最近文本时间戳（waiting 的文本静默判定依赖它）
    lastTextDeltaAt.value = Date.now()
    const last = lastAssistant()
    if (last) {
      last.content += text
    }
  }

  function replaceAssistantText(text: string) {
    const last = lastAssistant()
    if (!last) return
    last.textReplaceHistory = [...(last.textReplaceHistory ?? []), text]
    last.content = text
    ensureExecutionTrace()
    if (last.executionTrace) {
      applyTextReplaceStage(last.executionTrace, text)
    }
  }

  function addToolCall(name: string, result?: unknown) {
    const last = lastAssistant()
    if (last) {
      last.toolCalls?.push({ name, result })
      ensureExecutionTrace()
      if (last.executionTrace) {
        applyToolCall(last.executionTrace, name, result)
      }
    }
  }

  function beginToolCall(call: { toolCallId?: string; name: string; args?: unknown }) {
    const last = lastAssistant()
    if (!last) return
    last.toolCalls?.push({
      name: call.name,
      toolCallId: call.toolCallId,
      argsSummary: summarizeToolArgs(call.name, call.args),
    })
    ensureExecutionTrace()
    if (last.executionTrace) {
      applyToolCall(last.executionTrace, call.name, undefined, {
        toolCallId: call.toolCallId,
        args: summarizeToolArgs(call.name, call.args),
      })
    }
  }

  function endToolCall(toolCallId: string | undefined, name: string, result?: unknown, isError?: boolean) {
    // tool_result 落点：propose_generation 返回 pending_confirm → waiting 一票通过信号
    if (
      name === 'propose_generation'
      && (result as { status?: string } | null)?.status === 'pending_confirm'
    ) {
      proposePendingConfirm.value = true
    }
    const last = lastAssistant()
    if (!last) return
    if (toolCallId) {
      const entry = last.toolCalls?.find(
        (tc) => tc.toolCallId === toolCallId && tc.result === undefined,
      )
      if (entry) entry.result = result
      if (!entry) last.toolCalls?.push({ name, result, toolCallId })
    }
    ensureExecutionTrace()
    if (last.executionTrace) {
      applyToolCall(last.executionTrace, name, result, { toolCallId, isError: isError === true })
    }
  }

  function trackCanvasAction(action: CanvasAction) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) {
      applyCanvasAction(last.executionTrace, action)
    }
  }

  function trackNodeStatus(data: { nodeId: string; status: string; url?: string }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) {
      applyNodeStatus(last.executionTrace, data)
    }
  }

  function trackTaskUpdate(data: {
    id: string
    status: string
    title?: string
    nodeId?: string
    errorHint?: string
    errorCode?: string
  }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) {
      applyTaskUpdate(last.executionTrace, data)
    }
  }

  function trackStep(data: Parameters<typeof applyStep>[1]) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyStep(last.executionTrace, data)
  }

  function trackPhaseHint(data: { phase?: string; label: string }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyPhaseHint(last.executionTrace, data)
  }

  function trackStructuredError(data: Parameters<typeof applyStructuredError>[1]) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyStructuredError(last.executionTrace, data)
  }

  function trackThinking(data: { status: string; summary?: string }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyThinking(last.executionTrace, data)
  }

  /** P1：turn_usage 事件落 trace（摘要行数据源），沿 thinking 同款接线。 */
  function trackTurnUsage(data: { inputTokens: number; outputTokens: number }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyTurnUsage(last.executionTrace, data)
  }

  function trackExplore(data: Parameters<typeof applyExplore>[1]) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyExplore(last.executionTrace, data)
  }

  /**
   * canvas_action 事件落点（2026-10-01 修）：只记 trace；上屏改为 SideRail 流内
   * 即时 emit('canvasActions') 直达 CanvasPage —— 旧 pendingActions 积压到流结束
   * 才 flush，阻塞 propose 等待期节点永不上屏（PR #87 伴生回归的根因之一）。
   * 重复投递由 #91 的 add_node 按 id upsert 幂等保底。
   */
  function addCanvasAction(action: CanvasAction) {
    trackCanvasAction(action)
  }

  function finishStreaming() {
    const last = lastAssistant()
    if (last?.executionTrace) {
      finalizeExecutionTrace(last.executionTrace)
    }
    if (last) last.streaming = false
    isStreaming.value = false
    // 回合结束即无等待（后端 resolved 事件可能因断流迟到，这里再兜一次）
    blockingWait.value = null
  }

  /**
   * 阻塞等待置位/清位（`waiting_user` 事件，2026-10-01）。
   * `status:"resolved"` 或空工具名一律清位——宁可少显示等待，也不要卡在「等待你确认」。
   */
  /** 缺省 300000ms 与线上 `ASK_USER_TIMEOUT_MS` 对齐（runtime 未下发 timeoutMs 时的兜底）。 */
  const BLOCKING_WAIT_DEFAULT_TIMEOUT_MS = 300_000

  function setBlockingWait(
    wait: { toolName: string; callId?: string; nodeId?: string; question?: string; timeoutMs?: number } | null,
  ) {
    if (!wait?.toolName) {
      blockingWait.value = null
      return
    }
    blockingWait.value = {
      ...wait,
      deadlineAt: Date.now() + (wait.timeoutMs ?? BLOCKING_WAIT_DEFAULT_TIMEOUT_MS),
    }
  }

  /**
   * `activity` 事件落点（决策 8）：只收中文翻译需要的原始数据，**不在这里翻中文**。
   * 中文由组件层 `describeRuntimeActivity` 查 `TOOL_PRESENTATION` 目录出（决策 7：
   * agent 只声明意图、措辞归客户端），避免 store 里塞文案。
   * 空工具名一律清位——宁可回落 trace 旧措辞，也不要在状态行吐出空字。
   */
  function setActivity(next: { toolName?: string; done?: number; total?: number } | null) {
    activity.value = next?.toolName ? { ...next } : null
  }

  function parseAttachments(raw: string | undefined): SidebarAttachment[] | undefined {
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? validateSidebarAttachments(parsed) : undefined
    } catch {
      return undefined
    }
  }

  function parseLinkedOutputs(raw: string | undefined | null): LinkedCanvasOutput[] | undefined {
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return undefined
      const outputs: LinkedCanvasOutput[] = []
      for (const item of parsed) {
        const result = LinkedCanvasOutputSchema.safeParse(item)
        if (result.success) outputs.push(result.data)
      }
      return outputs.length > 0 ? outputs : undefined
    } catch {
      return undefined
    }
  }

  function parseMessageMetadata(raw: string | undefined): AgentMessageMetadata | undefined {
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as AgentMessageMetadata
    } catch {
      return undefined
    }
  }

  function restoreExecutionTrace(meta: AgentMessageMetadata | undefined): ExecutionTraceState | undefined {
    const raw = meta?.executionTrace as ExecutionTraceState | undefined
    if (!raw?.steps?.length) return undefined
    return {
      steps: raw.steps,
      collapsed: raw.collapsed ?? true,
      turnStartedAt: raw.turnStartedAt ?? Date.now(),
      turnEndedAt: raw.turnEndedAt,
      totalMs: raw.totalMs,
      usage: raw.usage,
    }
  }

  /**
   * 入参类型是 `PersistedAgentMessage` 而非 `AgentChatMessage`：
   * 函数体第一行就 `m as PersistedAgentMessage` 解构 `metadata`，而 persisted 行
   * 的 `metadata` 来自后端 JSON 字段，**可能为 null**（shared 的 `AgentChatMessage`
   * 声明的是 `metadata?: string`，两者对不上）。
   * ⚠️ 声明窄类型会让调用方（svgCardReplay 测试等）被迫绕开 shared 另写局部结构，
   * 却在传参处仍报 TS2322（vitest 走 esbuild 不查类型 ⇒ 本地绿、CI `vue-tsc` 红）。
   * 签名对齐真实契约，函数体那句断言才可以删。
   */
  function loadHistory(history: PersistedAgentMessage[]) {
    messages.value = history.map((persisted) => {
      const meta = parseMessageMetadata(persisted.metadata)
      let executionTrace = restoreExecutionTrace(meta)
      if (!executionTrace && meta?.executionEvents?.length) {
        executionTrace = replayExecutionTraceEvents(meta.executionEvents)
      }
      // svg_card 刷新恢复（spec §4.6 第 3 跳）：卡片随 canvas_command 落在
      // metadata.executionEvents 里（服务端 buildTurnMetadata 不写 metadata.presentation），
      // 刷新后从这里重放出与实时路径同形的 envelope，交给与 setPresentation 同一个挂载点。
      //
      // ⚠️ 与 trace 分支的 `!executionTrace &&` 门不同：这里**无条件**重放。
      // 那道门是「executionTrace 快照优先、事件序列兜底」，而 presentation 只有
      // 事件序列这一条来源（无快照可优先）；加门会让「带 trace 快照的老消息丢卡片」。
      // 重放是纯函数、不碰 store，同 tick 内完成，无时序竞态。
      //
      // role 门与 `setPresentation` 对齐（那条只写最后一条 assistant 消息）：
      // 卡片是助手轮次的产出，挂在 user 消息上没有对应语义。
      const replayedCard =
        persisted.role === 'assistant' && meta?.executionEvents?.length
          ? replaySvgCardPresentation(meta.executionEvents)
          : undefined
      const presentation =
        meta?.presentation && typeof meta.presentation === 'object'
          ? (meta.presentation as unknown as AgentPresentationEnvelope)
          : replayedCard
      return {
        id: persisted.id,
        role: persisted.role as 'user' | 'assistant',
        content: persisted.content,
        attachments: parseAttachments(persisted.attachments),
        linkedOutputs: parseLinkedOutputs(persisted.linkedOutputs),
        canvasActions: parsePersistedToolCalls(persisted.toolCalls),
        executionTrace,
        presentation,
      }
    })
  }

  /** P1 状态行：SSE error 事件 / 请求异常时置位本回合失败态（新回合由 addUserMessage 重置）。 */
  function markTurnError(err: unknown) {
    turnError.value = err
  }

  function clear() {
    messages.value = []
    proposePendingConfirm.value = false
    blockingWait.value = null
    activity.value = null
    lastTextDeltaAt.value = 0
    turnError.value = null
  }

  return {
    messages,
    isStreaming,
    proposePendingConfirm,
    blockingWait,
    activity,
    lastTextDeltaAt,
    turnError,
    setBlockingWait,
    setActivity,
    addUserMessage,
    startAssistantMessage,
    setPresentation,
    appendText,
    replaceAssistantText,
    addToolCall,
    beginToolCall,
    endToolCall,
    trackNodeStatus,
    trackTaskUpdate,
    trackStep,
    trackPhaseHint,
    trackStructuredError,
    trackThinking,
    trackExplore,
    addCanvasAction,
    markTurnError,
    trackTurnUsage,
    finishStreaming,
    loadHistory,
    clear,
  }
})
