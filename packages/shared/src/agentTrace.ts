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
  /**
   * TURN-IDENTITY PR2：本条账本**不完整**（捕获窗口没覆盖 run 起点）。
   *
   * 真值 =「本流没看到 `agent_start` 却有后续事件」——订阅切片 / 断线重连从半路
   * 接入时的形态。落库**必须**标出来：不标的话，前端拿一条残缺账本重放，
   * 会把孤儿 `tool_result` 渲染成一条无头工具行并顶在思考之前（原漂移事故）。
   * 反过来，**绝不允许**用补齐/插值去把 partial 抹平——那是冒充全量（N4）。
   */
  partial?: boolean
  /** 缺口起点：本流捕获到的首个全局序号（此序号之前的事件没被看到）。仅 `partial` 时携带。 */
  gapFrom?: number
  /**
   * D2（multi-device Task 2）：本条账本**尾部被截断**（消费方断连 / 连接被掐断，
   * Nest 侧只拿到 run 的前缀，后续事件仍在 pi 侧发生但没被捕获）。
   *
   * 与 `partial` 的区别必须讲清楚——**方向相反**：
   * - `partial` = **头部**缺口（没看到 run 起点，前半段在别的流/别的连接里）；
   * - `truncated` = **尾部**缺口（看到了起点，但后半段没被捕获）。
   *
   * ⛔ 绝不用 `partial` 表达截断：那样会让读端以为「前半段没看到」，而实际上
   * 前半段在、后半段丢——方向说反比不说更糟。
   *
   * 两种标志可同时为真（`partial:true, truncated:true`）：账本既非全量、也不是全量的一半，
   * 而是「两头都不齐」。此时读端**必须**回退到「以 pi 侧 transcript 为准」的路径，
   * 不得拿本行当全量重放。
   */
  truncated?: boolean
  /** PR4 历史修复：本行被判定为影子行时指向 owner 消息 id；读取出口据此过滤。 */
  supersededBy?: string
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
