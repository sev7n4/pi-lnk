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

type PersistedAgentMessage = AgentChatMessage & { linkedOutputs?: string | null; metadata?: string | null }

export const useAgentStore = defineStore('agent', () => {
  const messages = ref<AgentStreamMessage[]>([])
  const isStreaming = ref(false)
  const pendingActions = ref<CanvasAction[]>([])
  /** P1 状态行：本回合 propose_generation 已返回 pending_confirm（waiting 一票通过） */
  const proposePendingConfirm = ref(false)
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
    // 新回合开始：重置回合级状态行信号（propose 置位 / 文本时间戳 / 失败态）
    proposePendingConfirm.value = false
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

  function addCanvasAction(action: CanvasAction) {
    trackCanvasAction(action)
    pendingActions.value.push(action)
  }

  function flushActions(): CanvasAction[] {
    const actions = [...pendingActions.value]
    pendingActions.value = []
    return actions
  }

  function finishStreaming() {
    const last = lastAssistant()
    if (last?.executionTrace) {
      finalizeExecutionTrace(last.executionTrace)
    }
    if (last) last.streaming = false
    isStreaming.value = false
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

  function loadHistory(history: AgentChatMessage[]) {
    messages.value = history.map((m) => {
      const persisted = m as PersistedAgentMessage
      const meta = parseMessageMetadata(persisted.metadata)
      let executionTrace = restoreExecutionTrace(meta)
      if (!executionTrace && meta?.executionEvents?.length) {
        executionTrace = replayExecutionTraceEvents(meta.executionEvents)
      }
      const presentation =
        meta?.presentation && typeof meta.presentation === 'object'
          ? (meta.presentation as unknown as AgentPresentationEnvelope)
          : undefined
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
    pendingActions.value = []
    proposePendingConfirm.value = false
    lastTextDeltaAt.value = 0
    turnError.value = null
  }

  return {
    messages,
    isStreaming,
    pendingActions,
    proposePendingConfirm,
    lastTextDeltaAt,
    turnError,
    addUserMessage,
    startAssistantMessage,
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
    flushActions,
    markTurnError,
    trackTurnUsage,
    finishStreaming,
    loadHistory,
    clear,
  }
})
