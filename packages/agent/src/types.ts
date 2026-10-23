import type { CanvasAction, CanvasData, Shot } from '@lnkpi/shared'

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: AgentToolCall[]
  toolCallId?: string
  createdAt: string
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface AgentToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[] }>
    required: string[]
  }
}

export interface AgentContext {
  sessionId: string
  canvasData: CanvasData
  shots: Shot[]
  userMessage: string
  history: AgentMessage[]
}

export interface PresentationEnvelope {
  kind: string
  stepper?: { current: string; completed?: string[] }
  context_recap?: string
  body?: Record<string, unknown>
  primary_action?: { label: string; message: string }
  secondary_actions?: Array<{ label: string; message: string }>
}

export interface AgentStreamEvent {
  type:
    | 'text_delta'
    | 'text_replace'
    | 'tool_call'
    | 'tool_result'
    | 'canvas_action'
    // UI 命令（focus/undo/redo/open_image_editor），AgentSideRail canvas_command 分支消费
    | 'canvas_command'
    | 'node_status'
    | 'task_list'
    | 'task_update'
    | 'task_summary'
    | 'step'
    | 'phase_hint'
    | 'thinking'
    // P1 回合 token 实耗（message_end.usage 汇总，agent_end 前恰发一次）
    | 'turn_usage'
    | 'explore'
    | 'interrupt'
    | 'force_choice'
    | 'run_cancelled'
    | 'ping'
    // SSE 保活帧（控制器每 15s 下发，浏览器 touch 重置 stale 计时，避免长任务误判不可达）
    | 'heartbeat'
    // ③ 重跑：后端线程截断完成，会话已 fork 出新分支。
    // data: { threadId: string } —— 前端须把 agentThreadId 切换为该值（后续发送/订阅都用它），
    // 否则下一次发送仍落在被截断前的旧线程上。
    | 'thread_forked'
    // SEL-REF：服务端确认本轮**实际注入**了哪些选中节点（评审 C1）。
    // data: { nodes: Array<{ id, type, title }> } —— 只有收到它，前端才显示指代回执；
    // 缺省即代表服务端没注入（开关关闭 / 节点全失效），此时**不得**显示「已绑定」。
    | 'selection_binding'
    // TURN-IDENTITY（回合身份 / 单一写者）：本轮提交**未被接受**的结构化拒绝。
    // data: { reason: 'not_idle' | 'not_steerable' }
    //   · not_idle       —— 该会话已有 run 在跑（pi-runtime 409 / 上游 LaneBusy），
    //                        本次发言已并入在跑的 run；本流降级为旁听（转发不落库）。
    //   · not_steerable  —— 想并入但队列也塞不进去（会话已回收 / runtime 异常），
    //                        发言可能丢失，UI 须明确告知而不是假装已受理。
    // 对齐 Codex `NotSubmittedReason`：被拒绝的提交**不得**退化成一个新回合。
    // 409 是传输层信号，语义太薄（UI 拿不到 reason 就没法分文案），故显式下发。
    | 'turn_not_submitted'
    // D4（multi-device Task 6，spec §5.2 ConversationAck）：流末尾的**服务端裁定**。
    // data: { runId?: string; mode: 'run' | 'steer' | 'followup'; reason?: 'not_idle' | 'not_steerable' }
    //   · run         —— 空闲 ⇒ 本流发起新 run（owner，唯一落库者）
    //   · steer       —— 忙碌 ⇒ 发言并入在跑 run 的 steer 队列（本轮 turn 边界接住）
    //   · followup    —— 忙碌且 steer 塞不进去 ⇒ followUp 兜底（收尾边界接住，消息不蒸发）
    //   · reason      —— 仅 mode!=='run' 时出现：说明为什么不是新开一轮（恒 not_idle）
    //   · runId       —— 观测值（事件流里的 runId）；runtime 未透传时**不出现该键**
    //   · messageId   —— 本期不出现（插话落库是 Task 8；提前发就是假装已落库）
    // ⚠️ 与 turn_not_submitted 并存而非取代：后者是「未受理」的结构化拒绝（409 当刻下发），
    // 本事件是「已受理、归属如下」的末尾裁定——双失败 / 非 409 失败都不发（那些场景
    // 已有 turn_not_submitted / error 把话说清，ack 再发就是二次编造）。
    | 'turn_ack'
    | 'done'
    | 'error'
  data: unknown
}

export interface LLMProvider {
  chat(
    messages: Array<{ role: string; content: string }>,
    tools: AgentToolDefinition[],
    onEvent: (event: AgentStreamEvent) => void,
  ): Promise<void>
}

export interface ToolExecutor {
  execute(name: string, args: Record<string, unknown>, ctx: AgentContext): Promise<{
    result: unknown
    actions: CanvasAction[]
  }>
}
