/**
 * 多端一致性 P1（计划 2026-11-04 Task 5）：ack 化主流的**响应分派与解析**纯函数。
 *
 * 服务端 `STREAM_MAIN_FROM_PIRUNTIME=on` 时，POST /chat/conversation 返回
 * JSON ack（run 交后台 drain，事件改经 GET /runs/events 权威通道投递）；off 时
 * 返回 SSE 响应体流。**同一端点、同一请求**，前端无法预知服务端 flag ⇒ 唯一
 * 可靠判据是响应 **Content-Type**（application/json ⇒ ack 路径；text/event-stream
 * ⇒ 既有 POST 体流）。前置守卫（幂等缓存 / 意图去重 / 会话鉴权）两模式都保持
 * SSE 形态 ⇒ Content-Type 分派自动把它们路由回既有处理，服务端无需感知前端。
 *
 * 为什么抽独立模块：`AgentSideRail.vue` 已 ~6800 行，且这两个函数是「两端同源」
 * 契约的前端半边——独立模块才能在 Node 里直接单测（SFC 内联逻辑只能静态断言）。
 */

/** 服务端 AgentService.ConversationAck 的前端投影（结构对齐，不做类型依赖）。 */
export interface ConversationAck {
  accepted: boolean
  /** 订阅目标线程；fork（③ 重跑）场景 = fork 后的新线程 id。 */
  threadId?: string
  /**
   * 订阅游标锚点（触发时刻 lane head seq）。缺省 = 服务端游标未知 ⇒ 前端
   * from=now（宁失早帧——verify-before-fail 可自愈——不重放历史）。
   */
  sinceSeq?: number
  /** accepted=false 时的用户可读原因（fork 切点失效等）。 */
  errorMessage?: string
}

/** 响应头只取用到的形状（真实 Response 结构上满足）。 */
interface AckResponseLike {
  headers: { get: (name: string) => string | null }
}

/**
 * 该响应是否为 ack（JSON）而非 SSE 流。
 * ⛔ 判据只认 Content-Type：状态码 200 两模式都会出现，不能当分派依据。
 */
export function isConversationAckResponse(res: AckResponseLike): boolean {
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json')
}

/**
 * 解析 ack 响应体（{code, message, data} 包络 → ConversationAck）。
 * 形状非法（非对象 / accepted 非布尔 / sinceSeq 非非负整数）⇒ null，调用方按
 * 「发起失败」终态处理——静默错值比显式失败危险（本仓一贯裁决）。
 */
export function parseConversationAck(body: unknown): ConversationAck | null {
  if (typeof body !== 'object' || body === null) return null
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.accepted !== 'boolean') return null
  const ack: ConversationAck = { accepted: d.accepted }
  if (typeof d.threadId === 'string' && d.threadId) ack.threadId = d.threadId
  if (typeof d.sinceSeq === 'number' && Number.isInteger(d.sinceSeq) && d.sinceSeq >= 0) {
    ack.sinceSeq = d.sinceSeq
  }
  if (typeof d.errorMessage === 'string' && d.errorMessage) ack.errorMessage = d.errorMessage
  return ack
}
