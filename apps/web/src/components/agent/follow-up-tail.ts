/**
 * 会话级订阅流的循环与退避重连（multi-device Task 5 · Review Focus #1）。
 *
 * 为什么从 AgentSideRail.vue 抽出来：原实现是 SFC 里的模块级函数 + 模块级状态
 * （rounds / abort controller 跨组件实例共享），既无法单测「重连是否带游标」，
 * 多实例挂载时还会共享 3 轮配额。本工厂把状态收进实例，依赖（fetch / 计时）
 * 全部可注入 ⇒ 重连行为可以在 Node 里直接断言（fetch URL 即 observable exit）。
 *
 * ⭐⭐ 2026-10-24 语义变更：**从「本轮收尾后的 tail」改为「会话级常驻订阅」**。
 * 原语义只覆盖「本端 turn 收尾之后由 drain 派生的新一代」，而多端一致性的主诉
 * ——「另一端在跑，本端不刷新也能看见」——在本端不发消息时根本不会订阅。
 * 现在挂载即订阅（接线层负责），轮次上限取消，靠服务端心跳维持长连接。
 *
 * 行为契约（plan Task 5 + 2026-10-24 常驻化修订）：
 *  ① 断线按指数退避重连，且**带游标** `lastEventId` 续传（只补增量不重放）；
 *  ② 游标为 null 时绝不拼空值（pi-runtime 会落进 afterSeq=-1 全量重放）；
 *  ③ idle 闸门被**任何帧**刷新（含心跳）：常驻订阅的寿命应由服务端决定，
 *     前端只兜「服务端彻底静默」（默认 45s > 心跳 15s×2，容忍一次心跳丢失）；
 *  ④ 404 = 会话已删除，不重连；重连预算**累计不重置**（防「连上即断」死循环）；
 *  ⑤ 收到回合收束帧（done / turn_ack）回调 `onTurnEnd`，由宿主收尾旁观轮。
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
  /**
   * 回合收束（收到 `done` / `turn_ack`）：旁观轮到此为止，由宿主收尾
   * （结束 streaming、拉权威历史纠正）。可能被调用多次（done 后还有 ack）⇒ 需幂等。
   */
  onTurnEnd?: () => void
  /** 空闲闸门：这么久没收到**任何帧**就断开（默认 45s，须 > 服务端心跳周期×2）。 */
  idleMs?: number
  /**
   * 每实例最多几轮（turn 完成次数维度）。
   * 默认 **Infinity**：常驻订阅没有「几轮之后就不听了」的道理——那正是多端不一致的来源。
   */
  maxRounds?: number
  /** 单轮内退避重连上限（默认 5）。 */
  maxReconnects?: number
  backoffBaseMs?: number
  backoffCapMs?: number
}

export type FollowUpTailState = 'idle' | 'connecting' | 'streaming' | 'backoff'

/**
 * 回合收束事件：收到任一即通知宿主收尾旁观轮。
 *
 * - `done`：pi `agent_end` 的映射，一轮正常结束（turn_ack 在其后，故 onTurnEnd 可能来两次）；
 * - `turn_ack`：Task 6 的服务端裁定帧；
 * - `error` / `turn_not_submitted`：轮失败或未被受理 —— 同样是「这一轮到此为止」，
 *   不通知的话旁观端会永远停在 streaming（气泡一直转圈）。
 */
function isTurnTerminal(type: string): boolean {
  return type === 'done' || type === 'turn_ack' || type === 'error' || type === 'turn_not_submitted'
}

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
  const idleMs = deps.idleMs ?? 45_000
  const maxRounds = deps.maxRounds ?? Number.POSITIVE_INFINITY
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
          // 404 = 会话已删除（pi-runtime 语义）；401/403 = 鉴权失效（token 过期 / 被登出）。
          // 两者重连都无意义（重连只会再拿一次同样的状态码）⇒ 直接退，避免重连风暴。
          if (res.status === 404 || res.status === 401 || res.status === 403) return
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
              // 任何帧（含心跳与就绪注释帧）都刷新 idle：常驻订阅的寿命由服务端决定，
              // 前端闸门只兜「服务端彻底静默」。旧契约「只认业务事件」是为 tail 设计的
              // （有硬上限），常驻化后若沿用，静默会话会被前端自己 20s 掐断。
              idleTimer.refresh()
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
              } else if (payload.type === 'canvas_action') {
                deps.onCanvasAction(payload.data)
              } else if (isTurnTerminal(payload.type)) {
                deps.onTurnEnd?.()
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
