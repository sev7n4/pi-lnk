import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
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
  applyTurnSettled,
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
  refreshTimelineSummary,
  replayTimelineEvents,
  type TimelineEvent,
  type TimelinePart,
  type TurnTimeline,
} from '@/components/agent/turnTimeline'
import { reportWaitStarted, reportWaitResolved } from '@/components/agent/waitTelemetry'
import type { AgentPresentationEnvelope } from '@/components/agent/presentation/types'
import { useAuthStore } from '@/stores/auth'
import { randomId } from '@/utils/randomId'

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

/**
 * 本地消息 id 的唯一生成口（multi-device Task 3 · R6）。
 *
 * 旧实现 `msg-${Date.now()}` 在**同一毫秒**内多次调用必撞（同 tick 的 user +
 * assistant 气泡、插话气泡与正常发送同刻），撞 id ⇒ `v-for :key` 重复 ⇒
 * Vue DOM 复用错位 ⇒ 肉眼「消息顺序乱」。
 *
 * ⚠️ 生产是 `http://`（非安全上下文）⇒ `crypto.randomUUID` 不可用（[SecureContext]
 * 限定）⇒ **不得裸调它**：守卫 `randomId.guard.test.ts` 会拦下（历史上三次踩坑
 * 都是「点完一律提交失败、nginx 侧 0 请求」——请求根本没发出去）。统一走
 * `randomId()`：它自带「时间戳 + 随机串」降级，那条降级路径才是生产主路径，
 * 不是防御性代码（守卫：agent.messageIdentity.test.ts）。
 * Task 9 的 `clientId` 复用本函数（plan「Interfaces · Produces」）。
 */
export function nextLocalMessageId(): string {
  return `msg-${randomId()}`
}

export const useAgentStore = defineStore('agent', () => {
  const messages = ref<AgentStreamMessage[]>([])
  const isStreaming = ref(false)
  /** Q2（2026-10-14）：本回合实时预估积分（usage_delta 事件逐段覆盖，turn 结束清位）。
   * 状态行 running 段「预估 -N积分」数据源；纯展示预估，P2 落账后由 settled 权威值替代。 */
  const liveEstimatedCredits = ref<number | null>(null)
  /**
   * 等待态单一真相的查询侧（根治规格 2026-10-28）：当前处于 `pending_confirm` 的
   * proposal part（来自上游 `waiting_user` 事件，时间线 reducer 已把它收敛成 part）。
   * 画布节点内联确认面 / 对话流内联卡 / 底部状态行都只读它，不再用 `blockingWait` 这类
   * 并行 store 态。返回最后一个含 pending_confirm proposal 的 assistant 消息里的该 part。
   */
  const pendingProposal = computed(() => {
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const m = messages.value[i]
      if (m.role === 'assistant' && m.timeline) {
        const p = m.timeline.parts.find(
          (part): part is Extract<TimelinePart, { kind: 'proposal' }> =>
            part.kind === 'proposal' && part.status === 'pending_confirm',
        )
        if (p) return p
      }
    }
    return null
  })
  /**
   * 等待态单一真相的查询侧（ask_user）：当前处于 `pending_answer` 的 question part
   * （来自上游 `ask_user` 事件，时间线 reducer 已把它收敛成 part）。`AskUserCard` 与
   * 对话流内联卡都只读它，不再用 `pendingAskUser` 这类并行组件 ref。
   */
  const pendingQuestion = computed(() => {
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const m = messages.value[i]
      if (m.role === 'assistant' && m.timeline) {
        const p = m.timeline.parts.find(
          (part): part is Extract<TimelinePart, { kind: 'question' }> =>
            part.kind === 'question' && part.status === 'pending_answer',
        )
        if (p) return p
      }
    }
    return null
  })
  /**
   * P2「会话恢复中」：vendor `retry_scheduled{recovery:true}` 标记经 recovery 事件透传。
   * 瞬时态——真实进度事件（activity/tool_call）或回合结束（agent_end/error）清位，
   * 由组件层事件开关维护，这里只存值；状态行据此显示「会话恢复中」而非「上游响应超时」。
   */
  const recovering = ref(false)
  /** P1 状态行：最近一次 text_delta 时间戳（waiting 文本静默 ≥2s 判定用） */
  const lastTextDeltaAt = ref(0)
  /**
   * TURN-IDENTITY PR3：本回合发言**没有被受理**（服务端结构化拒绝 `turn_not_submitted`）。
   *
   * 存在理由：409（上游 LaneBusy）此前被 Nest 静默吞掉，用户看到的是「消息发出去了、
   * 界面在转圈、最后冒出一个别人的回答」。现在服务端把拒绝结构化下发，前端就必须
   * **把状态说清楚**——「已并入进行中的任务」与「当前无法插话」是两种截然不同的
   * 用户预期，混成一句「处理中」等于没说。
   *
   * 瞬时态：新回合开始（`addUserMessage`）时清位，不会跨回合误显示。
   */
  const turnRefusal = ref<'not_idle' | 'not_steerable' | null>(null)
  /** P1 状态行：本回合错误原文（渲染层经 failureReason 映射为人话，禁用 JSON 工具摘要） */
  const turnError = ref<unknown>(null)

  function setTurnRefusal(reason: 'not_idle' | 'not_steerable' | null) {
    turnRefusal.value = reason
  }
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

  /**
   * 在**最后一条 assistant 消息之前**插入一条 user 消息。
   *
   * 用途（2026-10-21）：插话（steer / followUp）被模型真正消费的那一刻补建用户气泡。
   * 插话走队列 API，本地**不**插入气泡 ⇒ 模型消费后对话流里会出现
   * 「用户说了话、却没有用户气泡」的空洞。
   *
   * 为什么不能直接用 {@link addUserMessage}：
   *  ① 它 push 到**末尾** —— 而流式中 assistant 气泡已存在且持续累积正文，
   *     追加到末尾会让用户气泡排到 assistant **之后**（顺序错乱：模型的回答
   *     会显示在用户那句话前面）。
   *  ② 它会**重置回合级瞬态**（propose 置位 / blockingWait / recovering /
   *     turnError / turnRefusal）—— 插话发生在**本轮中途**，重置这些等于
   *     把本轮的阻塞等待与失败态一起抹掉。
   *
   * 也没有 assistant 气泡可插（极少见：流已断）⇒ 退化为追加到末尾。
   */
  function insertUserMessageBeforeAssistant(
    content: string,
    extras?: {
      entryId?: string
      attachments?: SidebarAttachment[]
      attachmentRefKeys?: string[]
      selectionNodeIds?: string[]
    },
  ) {
    let at = messages.value.length
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const m = messages.value[i]
      if (m && m.role === 'assistant') {
        at = i
        break
      }
    }
    const msg: AgentStreamMessage = {
      id: nextLocalMessageId(),
      role: 'user',
      content,
      ...(extras?.entryId ? { entryId: extras.entryId } : {}),
      ...(extras?.attachments?.length
        ? { attachments: extras.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
      ...(extras?.attachmentRefKeys?.length ? { attachmentRefKeys: [...extras.attachmentRefKeys] } : {}),
      ...(extras?.selectionNodeIds?.length ? { selectionNodeIds: [...extras.selectionNodeIds] } : {}),
    }
    messages.value.splice(at, 0, msg)
    return msg
  }

  function addUserMessage(
    content: string,
    extras?: {
      attachments?: SidebarAttachment[]
      attachmentRefKeys?: string[]
      selectionNodeIds?: string[]
    },
  ) {
    // 新回合开始：重置回合级状态行信号（恢复态 / 文本时间戳 / 失败态）
    recovering.value = false
    lastTextDeltaAt.value = 0
    turnError.value = null
    // TURN-IDENTITY PR3：新回合开始清掉「发言被拒」瞬时态，避免跨回合误显示
    turnRefusal.value = null
    messages.value.push({
      id: nextLocalMessageId(),
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
      id: nextLocalMessageId(),
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
    const last = lastAssistant()
    if (!last) return
    if (!last.timeline) last.timeline = createTurnTimeline()
    // T4 打点：waiting_user{resolved} ⇒ 先捕获等待中的 proposal part（callId+startedAt），
    // 应用后若翻 confirmed 则上报等待时长（时长取自 part.startedAt，无并行状态）。
    let resolvedProposal: { callId: string; startedAt: number } | null = null
    if (event.type === 'waiting_user' && event.data.status === 'resolved') {
      const wait = pendingProposal.value
      if (wait && wait.status === 'pending_confirm' && wait.callId) {
        resolvedProposal = { callId: wait.callId, startedAt: wait.startedAt }
      }
    }
    applyTimelineEvent(last.timeline, event)
    if (resolvedProposal) {
      reportWaitResolved('proposal', resolvedProposal.callId, 'confirmed', resolvedProposal.startedAt)
    }
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

  /**
   * 生成等待进度（2026-10-18 上游对齐）：run_* / propose 阻塞期的 onUpdate 快照
   * 经 tool_execution_update 派生为 generation_progress，落到持有该 nodeId 的
   * timeline artifact part 上（归属判定同 backfillTimelineNodeStatus：从最新往回找，
   * 找不到不伪造）。非终态事件，不刷新摘要快照。
   */
  function trackGenerationProgress(data: { nodeId?: string; elapsedMs?: number }) {
    if (!data?.nodeId || typeof data.elapsedMs !== 'number') return
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const m = messages.value[i]
      if (!m || m.role !== 'assistant' || !m.timeline) continue
      const owns = m.timeline.parts.some(
        (p) => p.kind === 'artifact' && p.nodeId === data.nodeId,
      )
      if (!owns) continue
      applyTimelineEvent(m.timeline, {
        type: 'generation_progress',
        data: { nodeId: data.nodeId, elapsedMs: data.elapsedMs },
      })
      return
    }
  }

  /**
   * 晚到生成状态回填时间线（2026-10-17 产物体验补全）。
   *
   * 背景：`node_status` SSE 事件当前**无服务端生产者**；回合流关闭后仍在生成的异步任务
   * （图片/视频常见），其终态没有任何通道进入时间线 ⇒ artifact part 永远停在
   * pending/running（无缩略图、无定位按钮）——这是「回合结束后产物消失」的根因之一。
   * useGenerationPolling 拿到权威终态后经本方法回填。
   *
   * 归属判定（关键）：从最新往回找「timeline 已持有该 nodeId artifact part」的
   * assistant 消息——产物归属**发起回合**，而非回填时刻恰好最后一条消息
   * （用户可能已经又发了新回合，回填绝不能污染新回合的时间线）。
   * 找不到归属就不伪造（N4：不冒充全量），静默跳过。
   */
  function backfillTimelineNodeStatus(data: { nodeId: string; status: string; url?: string }) {
    if (!data?.nodeId || !data.status) return
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const m = messages.value[i]
      if (!m || m.role !== 'assistant' || !m.timeline) continue
      const owns = m.timeline.parts.some(
        (p) => p.kind === 'artifact' && p.nodeId === data.nodeId,
      )
      if (!owns) continue
      applyTimelineEvent(m.timeline, {
        type: 'node_status',
        data: { nodeId: data.nodeId, status: data.status, url: data.url },
      })
      // 回合已收束 ⇒ 摘要 notice 的统计快照过期，随之原地刷新（「已生成 N 个产物」补计）
      refreshTimelineSummary(m.timeline)
      return
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
   * estimatedCredits：Q2 服务端预估积分（MarginPolicy+FX 折算，纯展示）；回合结束清实时态。
   * P2 T5：cacheReadTokens/cacheWriteTokens 三列分开透传（旧事件无字段 → 键不出现）。 */
  function trackTurnUsage(data: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    cost?: number
    estimatedCredits?: number
  }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyTurnUsage(last.executionTrace, data)
    feedTimeline({ type: 'turn_usage', data })
    liveEstimatedCredits.value = null
  }

  /** P2 T7：turn_settled 事件落 trace（settled 态摘要行/状态行数据源），沿 turn_usage 同款接线。
   * live 通道同时触发余额刷新（auth.refreshPoints 现成方法，内部吞错——计费展示绝不打断回合）。
   * settled 数据随既有 executionEvents 重放通道持久化（重放由 loadHistory 消费）。 */
  function trackTurnSettled(data: {
    holdId: string
    credits?: number
    breakdown?: { in: number; cache: number; out: number }
    ruleVersion?: string
    degraded?: boolean
    released?: boolean
  }) {
    ensureExecutionTrace()
    const last = lastAssistant()
    if (last?.executionTrace) applyTurnSettled(last.executionTrace, data)
    void useAuthStore().refreshPoints()
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

  /**
   * P1：waiting_user → 时间线 warn notice（设计 §10；D1 定位卡之外的时间线提示）。
   *
   * ADR-0011 T8（2026-10-20）：本事件是**阻塞态**（内核把决策权交回 host，等用户），
   * 与工具产出事件不同类；上游等价物为 `ui_prompt_start` / `ui_prompt_end`
   * （vendor coding-agent `core/extensions/types.ts:745-759`）。渲染落点由 ADR-0011
   * 收敛为**单一锚定表面**：propose 类阻塞的确认面在画布节点内联（ProposeConfirmOverlay），
   * 对话流只保留只读 notice。传输名不改（见 turnTimeline.ts 同名事件的注）。
   */
  function trackWaitingUser(data: {
    status?: string
    toolName?: string
    nodeId?: string
    reason?: string
    callId?: string
    title?: string
    timeoutMs?: number
  }) {
    // T4 打点：propose 等待开始（幂等键 callId；时长由 part.startedAt 承载）。
    if (data.status === 'waiting' && data.toolName === 'propose_generation' && data.callId) {
      reportWaitStarted('proposal', data.callId, {
        nodeId: data.nodeId ?? null,
        timeoutMs: data.timeoutMs ?? null,
      })
    }
    feedTimeline({ type: 'waiting_user', data })
  }

  /** 根治规格（2026-10-28）：ask_user 题面收敛进时间线单一真相（取代组件级 pendingAskUser ref）。 */
  function trackAskUser(data: {
    callId?: string
    title?: string
    questions: Array<{
      id: string
      question: string
      options: { label: string; value: string }[]
      multiSelect?: boolean
      allowOther?: boolean
    }>
  }) {
    // T4 打点：ask 等待开始（幂等键 callId）。
    if (data.callId) reportWaitStarted('question', data.callId)
    feedTimeline({ type: 'ask_user', data })
  }

  /**
   * 根治规格（2026-10-28）：提交/取消后把匹配的 question part 翻终态（answered/declined），
   * 或 POST 失败时回滚到 `pending_answer`（乐观置位防双击双发）。
   * 与 proposal 的 resolved 同构——等待态出口全部从 part 状态流转，无并行组件 ref。
   */
  function resolveQuestionPart(callId: string, status: 'answered' | 'declined' | 'pending_answer') {
    for (const m of messages.value) {
      if (m.role !== 'assistant' || !m.timeline) continue
      const p = m.timeline.parts.find(
        (part): part is Extract<TimelinePart, { kind: 'question' }> =>
          part.kind === 'question' && part.callId === callId,
      )
      if (p) {
        // T4 打点：翻终态上报等待时长（回滚到 pending_answer 不算终态，不打点）。
        if (status !== 'pending_answer') {
          reportWaitResolved(
            'question',
            callId,
            status === 'answered' ? 'answered' : 'skipped',
            p.startedAt,
          )
        }
        p.status = status
        break
      }
    }
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
    // 回合结束同样无「恢复中」（P2：瞬时态不跨回合残留）
    recovering.value = false
    // TURN-IDENTITY PR3：发言被拒的瞬时态也不跨回合残留
    turnRefusal.value = null
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
      settled: raw.settled,
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
    // P2 T7：重放通道含 turn_settled 回合 → 余额刷新一次（live 通道在 trackTurnSettled 触发；
    // 此处兜页面刷新/历史加载后 AccountPointsPill 与最近一次结算不同步的场景）。
    let historyHasSettled = false
    messages.value = history.map((persisted) => {
      const meta = parseMessageMetadata(persisted.metadata)
      if (meta?.executionEvents?.some((e) => e?.type === 'turn_settled')) {
        historyHasSettled = true
      }
      let executionTrace = restoreExecutionTrace(meta)
      if (!executionTrace && meta?.executionEvents?.length) {
        executionTrace = replayExecutionTraceEvents(meta.executionEvents)
      }
      // P1（agent-turn-timeline-design §5-P1 双源接入·历史）：flag 开启时由有序
      // executionEvents 重放出 TurnTimeline；bodyText 取自 persisted.content（历史无
      // text_delta，用正文补一个 done 文本块，避免时间线缺正文）。flag 关闭时不构建。
      let timeline: TurnTimeline | undefined
      if (meta?.executionEvents?.length) {
        // TURN-IDENTITY PR3：`partial` 是服务端判定的「账本不完整」（本流没捕获到
        // run 起点）⇒ 重放时置顶一条缺口标注，不让残缺过程冒充完整过程。
        // D2（multi-device Task 2）：`truncated` 是「尾部未捕获」（本流没等到 agent_end，
        // pi 侧那轮仍在跑）⇒ 方向与 partial 相反，**分别**标注，不混用。
        timeline = replayTimelineEvents(meta.executionEvents, persisted.content, {
          partial: meta.partial === true,
          truncated: meta.truncated === true,
        })
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
    if (historyHasSettled) void useAuthStore().refreshPoints()
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
    recovering.value = false
    lastTextDeltaAt.value = 0
    turnError.value = null
    turnRefusal.value = null
  }

  return {
    messages,
    isStreaming,
    liveEstimatedCredits,
    pendingProposal,
    pendingQuestion,
    recovering,
    lastTextDeltaAt,
    turnError,
    turnRefusal,
    setTurnRefusal,
    setRecovering,
    addUserMessage,
    insertUserMessageBeforeAssistant,
    confirmSelectionBinding,
    startAssistantMessage,
    setPresentation,
    appendTurnNotice,
    appendText,
    replaceAssistantText,
    beginToolCall,
    endToolCall,
    trackNodeStatus,
    trackGenerationProgress,
    backfillTimelineNodeStatus,
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
    trackTurnSettled,
    trackUsageDelta,
    trackWaitingUser,
    trackAskUser,
    resolveQuestionPart,
    finishStreaming,
    loadHistory,
    clear,
  }
})
