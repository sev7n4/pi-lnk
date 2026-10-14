/**
 * 回合执行事件（落库于 `metadata.executionEvents`）。
 *
 * 数组下标即发生顺序（SSOT）。`seq`/`ts`/`messageIndex` 是 P2 起的**显式化**字段：
 * - `seq`：回合内单调序号（从 1 起），跨「数组被裁剪/合并」时仍可稳定排序；
 * - `ts`：事件落到 Nest 侧的时刻（epoch ms），用于跨来源对齐（历史上靠到达序，无时间锚）；
 * - `messageIndex`：回合内第几条 assistant 消息（以 `message_end` 分段，0 起），
 *   供时间线还原「多段叙述各自成块」的块归属。
 *
 * ⚠️ 三者皆**可选**：老消息没有这些字段，消费端必须回退「按数组下标」语义（兼容不破）。
 */
export interface PersistedExecutionEvent {
  type: string
  data: unknown
  seq?: number
  ts?: number
  messageIndex?: number
}

export interface AgentMessageMetadata {
  executionTrace?: ExecutionTraceState
  presentation?: Record<string, unknown>
  executionEvents?: PersistedExecutionEvent[]
}

export type ExecutionEventKind =
  | 'text_stage'
  | 'canvas'
  | 'task'
  | 'tool_call'
  | 'macro_select'

export interface ExecutionEvent {
  kind: ExecutionEventKind
  ts: number
  payload: Record<string, unknown>
}

export interface ExecutionTraceState {
  events: ExecutionEvent[]
  updatedAt: number
}
