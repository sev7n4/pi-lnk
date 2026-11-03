/**
 * 主流统一传输的消费面（multi-device P1 · 计划 2026-11-04 Task 5/6）。
 *
 * 背景：flag on 时 POST /chat/conversation 不再回流事件（仅回 JSON ack：
 * threadId + sinceSeq），主流改经**权威通道** `GET /runs/events` 消费同一份
 * pi-runtime lane buffer —— 与旁观流同源（mapPiEventToUiEvent 契约一致），
 * 带 `id:` 帧游标（P0 lastMainSeq 捕获继续生效，断流对账路径零改动）。
 *
 * 为什么抽纯模块：AgentSideRail.vue 6800+ 行， sendMessage 的消费循环若内联
 * 无法单测「游标解析 / 终止判定 / 帧容错」。本模块依赖全可注入 ⇒ Node 直测。
 *
 * ⛔ 复用既有 `extractSseFrames`/`parseSseFrameSeq`（规格全局约束：禁止第二套
 *   split('\n') 解析器——POST 流的旧解析是历史遗留，随 off 路径保留，不扩散）。
 *
 * 终止语义（Task 6）：on 路径以**回合收束帧**（done / turn_ack / error /
 * turn_not_submitted，与 follow-up-tail 的 isTurnTerminal 同集合）自然终局；
 * `[DONE]` 是 POST 流专属的 legacy 帧，GET 通道不产生、本模块也不认。
 * clean end 而未见收束帧 ⇒ `endedNaturally=false` ⇒ 调用方走既有 P0
 * verify-before-fail 对账路径（先查真相再判失败，红车根因防线原样继承）。
 */
import { extractSseFrames, parseSseFrameSeq } from './observer-stream'

/** 服务端 startConversationRun 的 ack（Task 4 契约）消费侧镜像。 */
export interface MainTurnAck {
  accepted: boolean
  threadId: string
  sinceSeq: number
  forkedThreadId?: string
  /** accepted=false 时的折义（Task 4 闸门）：幂等命中 / 意图重复 / 越权。 */
  reason?: 'idempotent_hit' | 'not_idle' | 'session_forbidden'
  status?: string
  resultSummary?: string
}

/**
 * 解析 POST 响应体为 ack。两种合法形态（Task 4 契约）：
 *  - 放行：{accepted:true, threadId, sinceSeq, forkedThreadId?}
 *  - 闸门拒绝：{accepted:false, reason, status?, resultSummary?}（无锚点字段）
 * 任何畸形（非 JSON / 缺 data / 关键字段缺失）⇒ null ⇒ 调用方按协议错误走
 * 断流对账路径，不得静默当成功。
 */
export function parseConversationAck(payload: unknown): MainTurnAck | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.accepted !== 'boolean') return null
  if (d.accepted) {
    if (typeof d.threadId !== 'string' || !d.threadId) return null
    if (typeof d.sinceSeq !== 'number' || !Number.isFinite(d.sinceSeq) || d.sinceSeq < 0) {
      return null
    }
  } else if (
    d.reason !== 'idempotent_hit' &&
    d.reason !== 'not_idle' &&
    d.reason !== 'session_forbidden'
  ) {
    return null
  }
  const ack: MainTurnAck = {
    accepted: d.accepted,
    threadId: typeof d.threadId === 'string' ? d.threadId : '',
    sinceSeq: typeof d.sinceSeq === 'number' && Number.isFinite(d.sinceSeq) ? d.sinceSeq : 0,
  }
  if (typeof d.forkedThreadId === 'string' && d.forkedThreadId) ack.forkedThreadId = d.forkedThreadId
  if (
    d.reason === 'idempotent_hit' ||
    d.reason === 'not_idle' ||
    d.reason === 'session_forbidden'
  ) {
    ack.reason = d.reason
  }
  if (typeof d.status === 'string') ack.status = d.status
  if (typeof d.resultSummary === 'string') ack.resultSummary = d.resultSummary
  return ack
}

/**
 * 回合收束帧集合 —— 与 follow-up-tail 的 `isTurnTerminal` **同一集合**
 * （done=agent_end 映射、turn_ack=Task 6 服务端裁定、error / turn_not_submitted
 * = 失败/未受理，也是「这一轮到此为止」）。
 */
export function isMainTurnTerminal(type: string): boolean {
  return (
    type === 'done' || type === 'turn_ack' || type === 'error' || type === 'turn_not_submitted'
  )
}

export interface MainTurnReaderLike {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
  /** 读循环结束后显式释放（连接卫生，同 follow-up-tail 的 TailReaderLike 契约）。 */
  cancel?: () => unknown
}

export interface ConsumeMainTurnDeps {
  /** 响应体 reader（与 follow-up-tail 的 TailReaderLike 同构：读完后宿主侧 cancel）。 */
  reader: MainTurnReaderLike
  /** 每个业务/心跳帧回调（宿主在统一收 text_delta / canvas_action / touch 等）。 */
  onEvent: (event: { type: string; data: unknown }) => void
  /** 游标帧回调（`id:` 行）：宿主落 lastMainSeq（P0 断流对账的续传锚点）。 */
  onCursor: (seq: number) => void
  /** 用户取消（与 POST 流同一个 AbortSignal 语义）。 */
  signal?: { aborted: boolean }
}

export interface ConsumeMainTurnResult {
  /** true = 收到回合收束帧自然终局（等价 off 路径的 streamEndedNormally）。 */
  endedNaturally: boolean
  /** 见到的最大 seq（未收到任何游标帧 = null）。 */
  lastSeq: number | null
}

/**
 * 消费 GET /runs/events 直到回合收束 / 流结束 / 取消。
 *
 * 帧处理顺序（与 follow-up-tail 同纪律）：**游标先落帧**——哪怕 payload 解析
 * 失败也不丢断点位置；`data: [DONE]` 解析会失败 ⇒ 自然跳过（不抛、不终止）。
 * 收束帧到达 ⇒ 立即 cancel reader（同一 lane 的后续事件——收尾边界后的 drain
 * 代际——由宿主 finally 里重挂的常驻旁观流接管，主流到此为止）。
 */
export async function consumeMainTurnStream(deps: ConsumeMainTurnDeps): Promise<ConsumeMainTurnResult> {
  let lastSeq: number | null = null
  let endedNaturally = false
  const decoder = new TextDecoder()
  let buffer = ''
  let reader: MainTurnReaderLike | null = null
  try {
    if (deps.signal?.aborted) return { endedNaturally: false, lastSeq }
    reader = deps.reader
    while (true) {
      if (deps.signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { frames, rest } = extractSseFrames(buffer)
      buffer = rest
      let stop = false
      for (const frame of frames) {
        if (deps.signal?.aborted) break
        // 游标先落帧（follow-up-tail 同款纪律）
        const seq = parseSseFrameSeq(frame)
        if (seq !== undefined) {
          lastSeq = seq
          deps.onCursor(seq)
        }
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let payload: { type: string; data?: unknown } | null = null
        try {
          payload = JSON.parse(line.slice(5).trim())
        } catch {
          continue // [DONE] / 畸形帧：跳过不抛
        }
        if (!payload || typeof payload.type !== 'string') continue
        deps.onEvent(payload as { type: string; data: unknown })
        if (isMainTurnTerminal(payload.type)) {
          endedNaturally = true
          stop = true
          break
        }
      }
      if (stop) break
    }
  } finally {
    if (reader) {
      const r = reader
      reader = null
      try {
        void r.cancel?.()
      } catch {
        /* 释放失败不影响主流程 */
      }
    }
  }
  return { endedNaturally, lastSeq }
}
