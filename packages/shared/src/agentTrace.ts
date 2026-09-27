export interface AgentMessageMetadata {
  executionTrace?: ExecutionTraceState
  presentation?: Record<string, unknown>
  executionEvents?: Array<{ type: string; data: unknown }>
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
