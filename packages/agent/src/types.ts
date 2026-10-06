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
