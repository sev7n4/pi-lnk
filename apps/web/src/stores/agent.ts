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
  replayNodeGraphPresentation,
  type ExecutionTraceState,
} from '@/components/agent/executionTraceReducer'
import {
  applyTimelineEvent,
  createTurnTimeline,
  finalizeTurnTimeline,
  replayTimelineEvents,
  type TimelineEvent,
  type TurnTimeline,
} from '@/components/agent/turnTimeline'
import { isFeatureOn } from '@/composables/useFeatureFlag'
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
  streaming?: boolean
  textReplaceHistory?: string[]
  executionTrace?: ExecutionTraceState
  presentation?: AgentPresentationEnvelope
  attachments?: SidebarAttachment[]
  attachmentRefKeys?: string[]
  /**
   * SEL-REF：本条消息发出时随请求上行的画布选中节点 id 集合（**发送瞬间的快照**）。
   * 仅作**本地留档**（审计/降级文案）——回执 chip 的数据源是下面的
   * `selectionBindingConfirmed`，因为前端读不到服务端的开关状态。
   * 空/缺省 ⇒ 该条无回执。
   */
  selectionNodeIds?: string[]
  /**
   * SEL-REF：**服务端确认**本轮实际注入了哪些节点（`selection_binding` 事件）。
   * 这是回执的**唯一**数据源 —— 缺省即代表服务端没注入，chip 不渲染
   * （评审 C1：按本地快照渲染会让回执在开关关闭时仍在说谎）。
   */
  selectionBindingConfirmed?: Array<{ id: string; type: string; title: string }>
  linkedOutputs?: LinkedCanvasOutput[]
  canvasActions?: CanvasAction[]
  /**
   * P1（agent-turn-timeline-design §4）：有序时间线模型层。`parts` 顺序 = 事件到达序，
   * 唯一真相，替代「trace 步骤 + 独立 body + 独立产物」的槽位拼装。flag `turn_timeline`
   * 关闭时**不创建**（零成本），渲染层按 flag 切流。
   */
  timeline?: TurnTimeline
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
  /** Q2（2026-10-14）：本回合实时预估积分（usage_delta 事件逐段覆盖，turn 结束清位）。
   * 状态行 running 段「预估 -N积分」数据源；纯展示预估，P2 落账后由 settled 权威值替代。 */
  const liveEstimatedCredits = ref<number | null>(null)
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
  /**
   * P2「会话恢复中」：vendor `retry_scheduled{recovery:true}` 标记经 recovery 事件透传。
   * 瞬时态——真实进度事件（activity/tool_call）或回合结束（agent_end/error）清位，
   * 由组件层事件开关维护，这里只存值；状态行据此显示「会话恢复中」而非「上游响应超时」。
   */
  const recovering = ref(false)
  /** P1 状态行：最近一次 text_delta 时间戳（waiting 文本静默 ≥2s 判定用） */
  const lastTextDeltaAt = ref(0)
  /** P1 状态行：本回合错误原文（渲染层经 failureReason 映射为人话，禁用 JSON 工具摘要） */
  const turnError = ref<unknown>(null)
  /**
   * PR1「让 Agent 诊断」：诊断抽屉点按钮后由 CanvasPage provide 写入预填文案，
   * AgentSideRail 消费后写入 composer 并聚焦（**不自动发送**——发送是用户显式意图）。
   * 单槽：写入即覆盖上一条未消费的预填（抽屉是单例，不会并发两条）。
   */
  const pendingDiagnosticText = ref<string | null>(null)

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
    extras?: {
      attachments?: SidebarAttachment[]
      attachmentRefKeys?: string[]
      selectionNodeIds?: string[]
    },
  ) {
    // 新回合开始：重置回合级状态行信号（propose 置位 / 阻塞等待 / 恢复态 / 文本时间戳 / 失败态）
    proposePendingConfirm.value = false
    blockingWait.value = null
    activity.value = null
    recovering.value = false
    lastTextDeltaAt.value = 0
    turnError.value = null
    messages.value.push({
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      attachments: extras?.attachments?.map((attachment) => ({ ...attachment })),
      attachmentRefKeys: extras?.attachmentRefKeys ? [...extras.attachmentRefKeys] : undefined,
      // SEL-REF：复制一份，避免外部数组后续被改（选中态是 reactive 的）
      selectionNodeIds: extras?.selectionNodeIds?.length ? [...extras.selectionNodeIds] : undefined,
    })
  }

  /**
   * SEL-REF：接收服务端 `selection_binding` 确认，挂到**最近一条 user 消息**。
   *
   * 为什么不用本地 id 快照当数据源（评审 C1）：前端读不到 Nest 的
   * `SEL_REF_ENABLED`。若按本地快照渲染，V1 默认态（off）下用户照样看到
   * 「已绑定 N 个选中节点」，而提示词里 0 字节注入 —— 回执是信任担保，
   * 担保说谎会引导用户去问无关问题。
   *
   * 空数组 ⇒ **不写**字段（区分「服务端明确没注入」与「事件还没到」：
   * 前者 chip 不渲染，后者 chip 暂不显示，都不该显示成「已绑定」）。
   */
  function confirmSelectionBinding(nodes: Array<{ id: string; type: string; title: string }>) {
    if (!nodes.length) return
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const m = messages.value[i]
      if (m.role === 'user') {
        messages.value[i] = { ...m, selectionBindingConfirmed: nodes.map((n) => ({ ...n })) }
        return
      }
    }
    // 没有 user 消息可挂 ⇒ 忽略（不得凭空造消息）
  }

  function startAssistantMessage() {
    // Q2：新回合开始，清掉上一回合的实时预估（状态行只显示本回合消耗）
    liveEstimatedCredits.value = null
    const msg: AgentStreamMessage = {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: '',
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
   * 无 assistant 消息时静默忽略：与 `appendText` 同款兜底，
   * 避免事件竞态（流早于 startAssistantMessage 到达）打断整条流。
   */
  /**
   * presentation kind 的**优先级**（数字越大越优先）。
   *
   * ⚠️ 为什么需要它（2026-07-23 修node_graph 被覆盖）：
   *   `render_canvas_view` 现在**双写** `node_graph` + `svg_card`，实时路径会**依次**调两次
   *   `setPresentation`。而 `presentation` 是**单值**字段（见上方注释）⇒ 后者无条件覆盖前者
   *   ⇒ 线上实际显示的是静态 SVG，A 方案（node_graph 优先）**在实时路径完全失效**。
   *
   * ⚠️ 只对**不同 kind** 生效；同 kind 仍是「后者覆盖前者」
   *   （既有回归锁「同轮第二张卡覆盖第一张」必须继续绿，见 `agent.setPresentation.test.ts`）。
   */
  const PRESENTATION_KIND_PRIORITY: Record<string, number> = {
    node_graph: 2, // Vue Flow 节点图 = 结构化、可交互，是本项目的目标形态
    svg_card: 1, // 静态 SVG = 降级兜底
  }

  function setPresentation(presentation: AgentPresentationEnvelope) {
    const last = lastAssistant()
    if (!last) return
    const incoming = PRESENTATION_KIND_PRIORITY[presentation.kind] ?? 0
    const current = last.presentation
    const currentRank = current ? (PRESENTATION_KIND_PRIORITY[current.kind] ?? 0) : -1
    // 同 kind（rank 相同）或没有更高优先级的新 kind ⇒ 按既有语义覆盖
    if (incoming >= currentRank) last.presentation = presentation
  }

  /**
   * P1（agent-turn-timeline-design §5-P1）：与 trace 并行的事件喂入。
   * flag `turn_timeline` 关闭时**直接返回**（零成本，旧 trace 路径完全不受影响）。
   * 自举创建消息上的 timeline（与 ensureExecutionTrace 同形），再 applyTimelineEvent 落 parts。
   */
  function feedTimeline(event: TimelineEvent) {
    if (!isFeatureOn('turn_timeline')) return
    const last = lastAssistant()
    if (!last) return
    if (!last.timeline) last.timeline = createTurnTimeline()
    applyTimelineEvent(last.timeline, event)
  }

  function appendText(text: string) {
    // text_delta落点：刷新最近文本时间戳（waiting 的文本静默判定依赖它）
    lastTextDeltaAt.value = Date.now()
    const last = lastAssistant()
    if (last) {
      last.content += text
      feedTimeline({ type: 'text_delta', data: { text } })
    }
  }

  /**
   * 回合级提示：**先确保存在 assistant 消息**，再落文本（2026-10-08）。
   *
   * 为什么需要它：`appendText` 在**没有 assistant 消息时静默 no-op**
   * （`if (last) last.content += text`，见其上方注释「无 assistant 消息时静默忽略」）。
   * 而「本轮一个事件都没收到」时 assistant 消息**压根不会被创建**
   * ⇒ 任何以 `appendText` 落地的兜底文案都落不了地、无声消失。
   *
   * 生产事故（2026-10-07）：run 被 vendor 以 `LaneBusy` 拒掉 ⇒ 零事件；
   * SSE 9ms 后断开 ⇒ 前端的「异常结束」兜底分支又全部以
   * `last?.role === 'assistant'` 为前提而全部落空 ⇒ 用户屏幕上什么都不出现。
   *
   * 语义边界：**不改变** `appendText` 本身的静默行为（多个既有调用方依赖它），
   * 只为「回合收尾提示」这一类必须可见文案的场合提供有保障的通道。
   */
  function appendTurnNotice(text: string) {
    if (!lastAssistant()) startAssistantMessage()
    appendText(text)
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
    feedTimeline({ type: 'text_replace', data: { text } })
  }

  function beginToolCall(call: { toolCallId?: string; name: string; args?: unknown }) {
    const last = lastAssistant()
    if (!last) return
    ensureExecutionTrace()
    if (last.executionTrace) {
      applyToolCall(last.executionTrace, call.name, undefined, {
        toolCallId: call.toolCallId,
        args: summarizeToolArgs(call.name, call.args),
      })
    }
    feedTimeline({ type: 'tool_call', data: { toolCallId: call.toolCallId, name: call.name, args: call.args } })
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
    ensureExecutionTrace()
    if (last.executionTrace) {
      applyToolCall(last.executionTrace, name, result, { toolCallId, isError: isError === true })
    }
    feedTimeline({ type: 'tool_result', data: { toolCallId, name, result, isError: isError === true } })
  }

  function trackCanvasAction(action: CanvasAction) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) {
      applyCanvasAction(last.executionTrace, action)
    }
    feedTimeline({ type: 'canvas_action', data: action })
  }

  function trackNodeStatus(data: { nodeId: string; status: string; url?: string }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) {
      applyNodeStatus(last.executionTrace, data)
    }
    feedTimeline({ type: 'node_status', data })
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
    feedTimeline({ type: 'task_update', data })
  }

  function trackStep(data: Parameters<typeof applyStep>[1]) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyStep(last.executionTrace, data)
    feedTimeline({ type: 'step', data })
  }

  function trackPhaseHint(data: { phase?: string; label: string }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyPhaseHint(last.executionTrace, data)
    feedTimeline({ type: 'phase_hint', data })
  }

  function trackStructuredError(data: Parameters<typeof applyStructuredError>[1]) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyStructuredError(last.executionTrace, data)
    feedTimeline({ type: 'error', data })
  }

  function trackThinking(data: { status: string; summary?: string }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyThinking(last.executionTrace, data)
    feedTimeline({ type: 'thinking', data })
  }

  /** P1：turn_usage 事件落 trace（摘要行数据源），沿 thinking 同款接线。
   * cost：渠道配了 pricing 时服务端折叠的 usage.cost 总额（可选透传）。
   * estimatedCredits：Q2 服务端预估积分（MarginPolicy+FX 折算，纯展示）；回合结束清实时态。 */
  function trackTurnUsage(data: { inputTokens: number; outputTokens: number; cost?: number; estimatedCredits?: number }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyTurnUsage(last.executionTrace, data)
    feedTimeline({ type: 'turn_usage', data })
    liveEstimatedCredits.value = null
  }

  /** Q2：usage_delta（transient 实时预估快照）→ 状态行 running 段「预估 -N积分」。
   * 只更新 live 态，不进时间线（重放走 turn_usage.estimatedCredits）。 */
  function trackUsageDelta(data: { inputTokens?: number; outputTokens?: number; estimatedCredits?: number }) {
    if (typeof data.estimatedCredits === 'number' && Number.isFinite(data.estimatedCredits)) {
      liveEstimatedCredits.value = data.estimatedCredits
    }
  }

  function trackExplore(data: Parameters<typeof applyExplore>[1]) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyExplore(last.executionTrace, data)
    feedTimeline({ type: 'explore', data })
  }

  /** P1：waiting_user → 时间线 warn notice（设计 §10；D1 定位卡之外的时间线提示）。 */
  function trackWaitingUser(data: { status?: string; toolName?: string; nodeId?: string; reason?: string }) {
    feedTimeline({ type: 'waiting_user', data })
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
    if (last?.timeline) {
      finalizeTurnTimeline(last.timeline)
    }
    if (last) last.streaming = false
    isStreaming.value = false
    // 回合结束即无等待（后端 resolved 事件可能因断流迟到，这里再兜一次）
    blockingWait.value = null
    // 回合结束同样无「恢复中」（P2：瞬时态不跨回合残留）
    recovering.value = false
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

  /** P2：recovery 事件落点——置位/清位「会话恢复中」（清位由组件层在真实进度事件里调用）。 */
  function setRecovering(next: boolean) {
    recovering.value = next
  }

  /** 入参放宽到 `string | null`，理由同 parseMessageMetadata：函数体 `if (!raw)` 早就能处理。 */
  function parseAttachments(raw: string | null | undefined): SidebarAttachment[] | undefined {
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

  /**
   * 入参放宽到 `string | null`。
   *
   * 函数体首行是 `if (!raw) return undefined`，运行时**早就正确处理 null**
   * （`!null === true`），只是签名没跟上 persisted 行的真实形状。
   * 声明窄类型 ⇒ Omit 修好调用侧之后立刻在这里报TS2345，
   * 等于「类型终于说对话了，把藏着的第二处脱节顶出来」。
   */
  function parseMessageMetadata(raw: string | null | undefined): AgentMessageMetadata | undefined {
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
      // P1（agent-turn-timeline-design §5-P1 双源接入·历史）：flag 开启时由有序
      // executionEvents 重放出 TurnTimeline；bodyText 取自 persisted.content（历史无
      // text_delta，用正文补一个 done 文本块，避免时间线缺正文）。flag 关闭时不构建。
      let timeline: TurnTimeline | undefined
      if (isFeatureOn('turn_timeline') && meta?.executionEvents?.length) {
        timeline = replayTimelineEvents(meta.executionEvents, persisted.content)
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
      // ⚠️ **A 方案优先级（2026-07）**：node_graph 优先、svg_card 降级。
      // 双写期两条载荷都在事件流里（后端 presentResultDual），
      // `??` 的左偏决定了"有 node_graph 就用它，没有才回落静态 SVG"。
      // 后端停止发 node_graph 时会自动回落，无需改前端。
      const replayedCard =
        persisted.role === 'assistant' && meta?.executionEvents?.length
          ? (replayNodeGraphPresentation(meta.executionEvents)
            ?? replaySvgCardPresentation(meta.executionEvents))
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
        timeline,
      }
    })
  }

  /** P1 状态行：SSE error 事件 / 请求异常时置位本回合失败态（新回合由 addUserMessage 重置）。 */
  function markTurnError(err: unknown) {
    turnError.value = err
  }

  /** PR1「让 Agent 诊断」：写入预填文案（由画布 provide 的 diagnose 函数调用）。 */
  function requestAgentDiagnose(text: string): void {
    pendingDiagnosticText.value = text
  }

  /** PR1「让 Agent 诊断」：AgentSideRail 消费后清空（一次性，避免重复预填）。 */
  function consumePendingDiagnosticText(): string | null {
    const text = pendingDiagnosticText.value
    pendingDiagnosticText.value = null
    return text
  }

  function clear() {
    messages.value = []
    proposePendingConfirm.value = false
    blockingWait.value = null
    activity.value = null
    recovering.value = false
    lastTextDeltaAt.value = 0
    turnError.value = null
  }

  return {
    messages,
    isStreaming,
    liveEstimatedCredits,
    proposePendingConfirm,
    blockingWait,
    activity,
    recovering,
    lastTextDeltaAt,
    turnError,
    setBlockingWait,
    setActivity,
    setRecovering,
    addUserMessage,
    confirmSelectionBinding,
    startAssistantMessage,
    setPresentation,
    appendTurnNotice,
    appendText,
    replaceAssistantText,
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
    pendingDiagnosticText,
    requestAgentDiagnose,
    consumePendingDiagnosticText,
    trackTurnUsage,
    trackUsageDelta,
    trackWaitingUser,
    finishStreaming,
    loadHistory,
    clear,
  }
})
