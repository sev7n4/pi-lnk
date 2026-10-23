/**
 * 旁听流（followUp tail）的循环与退避重连（multi-device Task 5 · Review Focus #1）。
 *
 * 为什么从 AgentSideRail.vue 抽出来：原实现是 SFC 里的模块级函数 + 模块级状态
 * （rounds / abort controller 跨组件实例共享），既无法单测「重连是否带游标」，
 * 多实例挂载时还会共享 3 轮配额。本工厂把状态收进实例，依赖（fetch / 计时）
 * 全部可注入 ⇒ 重连行为可以在 Node 里直接断言（fetch URL 即 observable exit）。
 *
 * 行为契约（plan Task 5）：
 *  ① 断线按指数退避重连，且**带游标** `lastEventId` 续传（只补增量不重放）；
 *  ② 游标为 null 时绝不拼空值（pi-runtime 会落进 afterSeq=-1 全量重放）；
 *  ③ idle 闸门只被**业务事件**刷新（Task 4 起服务端 15s 心跳不得让静默会话永不断）；
 *  ④ 404 = 会话已删除，不重连；重连预算**累计不重置**（防「连上即断」死循环）。
 */
import { backoffWithJitter } from './backoff'
import { buildObserverStreamUrl, extractSseFrames, parseSseFrameSeq } from './observer-stream'

/** 只取本模块用得到的 reader 结构（真实 fetch 的 Response 结构上满足它）。 */
interface TailReaderLike {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
}

/** 只取本模块用得到的 Response 结构（真实 fetch 的 Response 结构上满足它）。 */
export interface TailResponseLike {
  status: number
  ok: boolean
  body: { getReader: () => TailReaderLike } | null
}

export interface FollowUpTailDeps {
  fetchImpl: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<TailResponseLike>
  /** 认证头（旁听流要带 auth 头，用不了浏览器 EventSource 的自动续传）。 */
  headers: () => Record<string, string>
  /** 基础 URL（不含游标参数）；每次连接时求值，因为 threadId 可能已切换。 */
  baseUrl: () => string
  onTextDelta: (text: string) => void
  onCanvasAction: (data: unknown) => void
  /** 空闲闸门：这么久没有**业务事件**就断开（默认 20s）。 */
  idleMs?: number
  /** 每实例最多几轮（turn 完成次数维度，默认 3）。 */
  maxRounds?: number
  /** 单轮内退避重连上限（默认 5）。 */
  maxReconnects?: number
  backoffBaseMs?: number
  backoffCapMs?: number
}

export type FollowUpTailState = 'idle' | 'connecting' | 'streaming' | 'backoff'

export interface FollowUpTailListener {
  /** 新一轮：掐掉旧流重新挂（turn 完成路径的语义）。 */
  start: () => Promise<void>
  /**
   * 页面可见性恢复：state-aware——
   * idle 直接挂；backoff 等待中掐断重来（跳过排队，冻结期间计时器已停摆）；
   * connecting/streaming 不动（健康流不打断）。
   */
  resume: () => Promise<void>
  abort: () => void
  getState: () => FollowUpTailState
}

export function createFollowUpTailListener(deps: FollowUpTailDeps): FollowUpTailListener {
  const idleMs = deps.idleMs ?? 20_000
  const maxRounds = deps.maxRounds ?? 3
  const maxReconnects = deps.maxReconnects ?? 5
  const backoffBaseMs = deps.backoffBaseMs ?? 250
  const backoffCapMs = deps.backoffCapMs ?? 5000

  let rounds = 0
  let lastSeq: number | null = null
  let controller: AbortController | null = null
  let state: FollowUpTailState = 'idle'

  function abort(): void {
    if (controller) {
      controller.abort()
      controller = null
    }
    // 复位状态：否则「start() 掐旧流开新流」时 run() 的 idle 闸门会把新一轮挡住。
    // 旧循环随后会在自己的 await 点醒来，其 finally 见 controller 已不是自己 ⇒ 不清场。
    state = 'idle'
  }

  async function run(): Promise<void> {
    if (state !== 'idle') return
    rounds += 1
    if (rounds > maxRounds) return
    const local = new AbortController()
    controller = local
    // 手动造 idle 闸门而不用 `AbortSignal.any`：后者要 Chrome 116+/Safari 17.4+，
    // 本项目其余地方只用到 `AbortSignal.timeout`，别为一个旁听流引入新的兼容面。
    const idleTimer = setTimeout(() => local.abort(), idleMs)
    // 累计重连预算：**不因单次连接成功而重置**。若重置，「连上即断」的死循环
    // （每次 HTTP 200、立刻流断）会让预算永远耗不尽——实测 1.4s 内重连 8 次。
    // 轮内退避等级同样随累计次数指数增长（ cap 封顶），健康长流被 idle 闸门收尾。
    let reconnects = 0
    try {
      while (!local.signal.aborted) {
        state = 'connecting'
        const url = buildObserverStreamUrl(deps.baseUrl(), lastSeq)
        try {
          const res = await deps.fetchImpl(url, {
            headers: deps.headers(),
            signal: local.signal,
          })
          // 404 = 会话已删除（pi-runtime 语义）：重连无意义，直接退
          if (res.status === 404) return
          if (!res.ok || !res.body) throw new Error(`observer stream HTTP ${res.status}`)
          idleTimer.refresh()
          state = 'streaming'
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const { frames, rest } = extractSseFrames(buffer)
            buffer = rest
            for (const frame of frames) {
              // 批次中途被 abort（新一轮开始）⇒ 剩余帧不再处理，避免旧流尾巴
              // 在新流已开之后又追加一段文本。
              if (local.signal.aborted) break
              // 游标先落帧：哪怕 payload 解析失败也不丢断点位置
              const seq = parseSseFrameSeq(frame)
              if (seq !== undefined) lastSeq = seq
              const line = frame.split('\n').find((l) => l.startsWith('data:'))
              if (!line) continue
              let payload: { type: string; data?: unknown } | null = null
              try {
                payload = JSON.parse(line.slice(5).trim())
              } catch {
                continue
              }
              if (!payload) continue
              // 与主流的事件契约完全一致（Nest 两端共用 mapPiEventToUiEvent）。
              if (payload.type === 'text_delta') {
                deps.onTextDelta((payload.data as { text?: string } | undefined)?.text ?? '')
                // idle 只被**业务事件**刷新：Task 4 起服务端每 15s 发心跳帧，
                // 用心跳刷新会让静默会话永不断连，违背「旁听流有硬上限」的前提。
                idleTimer.refresh()
              } else if (payload.type === 'canvas_action') {
                idleTimer.refresh()
                deps.onCanvasAction(payload.data)
              }
            }
          }
          // 服务端 clean end（idle 闸门正常收尾）：不重连，等下一轮
          return
        } catch {
          // idle 闸门 / 主动 abort 是预期退出，不走重连分支
          if (local.signal.aborted) return
          reconnects += 1
          if (reconnects > maxReconnects) return
          state = 'backoff'
          await new Promise((resolve) =>
            setTimeout(resolve, backoffWithJitter(backoffBaseMs, backoffCapMs, reconnects)),
          )
        }      }
    } finally {
      clearTimeout(idleTimer)
      // 只清理「自己还是当前流」：被新一轮 abort 掉旧流时，finally 慢一步
      // 会把新流的引用清掉（visibility 重挂路径会触发这个竞态）。
      if (controller === local) {
        controller = null
        state = 'idle'
      }
    }
  }

  return {
    start: async () => {
      abort()
      await run()
    },
    resume: async () => {
      if (state === 'idle') {
        await run()
        return
      }
      if (state === 'backoff') {
        // 冻结期间退避计时器可能已停摆 ⇒ 掐断重来，游标续传不丢不重放
        abort()
        await run()
      }
      // connecting / streaming：健康流不打断
    },
    abort,
    getState: () => state,
  }
}
