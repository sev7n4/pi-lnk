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
  /**
   * TURN-IDENTITY P0-1：**会话级全局单调序号**（pi-runtime `entry.nextSeq++`，
   * 经 SSE 帧 `UiEvent.seq` 透传到 Nest）。与上面 `seq` 的区别必须讲清楚：
   *
   * - `seq` 是 **Nest 每条流各自从 1 起** 的局部自增（生产实证：同一次 run 的两条
   *   订阅切片 seq 分别为 1..72 / 1..55）。它只在「单条流、单回合」内单调，
   *   **跨流不可比、不可归并**。
   * - `gSeq` 是 pi-runtime **按会话**发出的全局序号，是与 `afterSeq` / `lastEventId`
   *   同一编号空间的权威序号 ⇒ 跨流可比、可用于重放补全与去重归并。
   *
   * ⚠️ 前端当前仍按 `seq` 排序：这让切片顺序「看着单调、实则错误」——正是
   * 「提议生成」卡片能伪装成合法顺序顶在思考之前的机理。修好 gSeq 后才有条件
   * 把排序键换成它（PR2）。
   *
   * 可选：runtime 未携带（旧版本 / 非流式合成事件）时缺省，消费端回退 `seq`。
   */
  gSeq?: number
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
