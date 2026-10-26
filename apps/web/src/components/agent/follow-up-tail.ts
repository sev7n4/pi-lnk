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
 * ⭐⭐⭐ 2026-10-24 语义变更（二次）：**clean end 不再等于「订阅结束」**。
 *
 * 生产取证（`GET /api/agent/runs/events` 实测 **47ms 断流**，15s 心跳从未发出）：
 *   pi-runtime 的 lane 是**内存态、per-thread、带 TTL**（30 分钟），
 *   「另一端还没在这个 thread 上跑过」⇒ `GET /sessions/:key/events` 返回 **404**。
 *   服务端旧语义把 404 当「会话已删除」⇒ 立即 end ⇒ 前端 clean-end 后也不重连
 *   ⇒ **旁听端永久失联** ⇒ 这正是用户主诉「刷新后才同步」的直接成因。
 *
 * ⇒ 三处语义随之改：
 *   ① 服务端 404 归入「退避重试，等 lane 出现」（`retryOnMissing`）；
 *   ② 前端 clean end ⇒ **重连**（不再 return）；
 *   ③ 空闲闸门触发 ⇒ **重连**（不再终止订阅）。
 *
 * 最终行为契约：
 *  ① 断线按指数退避重连，且**带游标** `lastEventId` 续传（只补增量不重放）；
 *  ② 游标为 null 时绝不拼空值（pi-runtime 会落进 afterSeq=-1 全量重放）；
 *  ③ idle 闸门被**任何帧**刷新（含心跳）：常驻订阅的寿命应由服务端决定，
 *     前端只兜「服务端彻底静默」（默认 45s > 心跳 15s×2，容忍一次心跳丢失）；
 *     ⭐ 但 idle 触发**不再是终止**，而是「这一程没服务到东西 ⇒ 换一程」（见 ⑥）。
 *  ④ 404/401/403 = 终态，不重连（重连只会再拿一次同样的状态码）；
 *  ⑤ 重连预算累计不重置（防「连上即断」死循环），但**健康连接豁免**：
 *     本连接产出过 **data 帧** ⇒ 服务端确实服务了一段 ⇒ 预算归零；
 *     零帧的「连上即断」不豁免 ⇒ 死循环仍能被预算掐断；
 *  ⑥ **没有任何一条路径会让订阅「静默终止」**：预算耗尽 ⇒ 冷却后重开一轮新预算；
 *     idle 触发 ⇒ 重连。终止只有三种：显式 `abort()`、404/401/403、组件卸载。
 *     ⭐ 这一条是「常驻订阅」承诺的全部意义——否则又回到「刷新才同步」。
 *  ⑦ 收到回合收束帧（done / turn_ack）回调 `onTurnEnd`，由宿主收尾旁观轮。
 *
 * ⭐ `start()` / `resume()` 的 promise 语义 = **「订阅已发起并拿到首个响应」**，
 *   **不是**「流已结束」。常驻订阅下流在服务端保持打开、clean-end 也只重连
 *   ⇒ 循环在 abort 前永不结束 ⇒ 若 promise 等的是「流结束」，调用方会永久挂起。
 */
import { backoffWithJitter } from './backoff'
import { buildObserverStreamUrl, extractSseFrames, parseSseFrameSeq } from './observer-stream'

/** 只取本模块用得到的 reader 结构（真实 fetch 的 Response 结构上满足它）。 */
interface TailReaderLike {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
  /**
   * ⭐ 2026-10-26 连接卫生：读循环结束（done / 异常 / abort / 换程）后**必须**显式
   *   cancel —— 只 abandon 不 cancel 时，浏览器对这条流施加背压、TCP 连接保持
   *   开放（服务端永远看不到客户端离开），逐程累积吃满同源 6 连接（生产实测 7 条）。
   */
  cancel?: () => unknown
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
  /**
   * 重连预算耗尽后的冷却时长（ms，默认 30s）。
   *
   * ⭐ 2026-10-24：**预算耗尽不是终态**——冷却后重开一轮新预算。
   * 常驻订阅的承诺是「只要会话开着就一直在听」；彻底停止会让本端永久失联
   * ⇒ 正是用户主诉「刷新后才同步」的成因之一。
   */
  reconnectCooldownMs?: number
  backoffBaseMs?: number
  backoffCapMs?: number
}

export type FollowUpTailState = 'idle' | 'connecting' | 'streaming' | 'backoff'

/**
 * 一轮订阅的生命周期句柄。
 *
 * ⭐ 用**对象**而不是单个 controller：显式 `abort()` 必须能同时停掉
 *   ① 正在进行的 fetch（否则它会一直挂着）② 退避等待（否则要等满退避时长）
 *   ③ 整轮循环（否则旧循环会变成「幽灵订阅」继续重连）。
 */
interface RunToken {
  /** 显式终止（用户切走 / 组件卸载 / 换会话）。 */
  stopped: boolean
  /**
   * 轮次序号：**最新轮次胜出**。
   *
   * ⭐ 2026-10-26 生产取证：同一 (sessionId, threadId) 被**同时开了 6 条** SSE，
   *   6 > Chrome 同源 6 连接上限 ⇒ 画布页自己的连接把普通请求全饿死
   *   （`GET /api/sessions/<id>` 排队 ⇒ **画布显示为空**）。
   *   ⇒ 结构性保证：**任何时刻只允许最新一轮继续发请求**，旧轮一律自杀。
   */
  seq: number
  /** 整轮的 signal：只被显式 abort 触发（idle 不碰它，idle 只掐当前这一程）。 */
  round: AbortController
  /** 当前这一程的 controller：显式 abort 与 idle 闸门都会掐它。 */
  attempt: AbortController | null
  /**
   * ⭐ 2026-10-26 连接卫生：本轮**全部**已开出的 attempt。
   *
   * ⛔ 单字段 `attempt` 每开新一程就被覆盖 ⇒ 旧 controller 丢失 ⇒ 旧连接再也掐不掉。
   *   掐一轮 = 遍历这里全掐（Set 自动去重，已结束的在 finally 摘除）。
   */
  attempts: Set<AbortController>
}

/**
 * 可被 abort 打断的等待（退避 / 冷却用）。
 *
 * ⛔ 旧实现用裸 `setTimeout`：`abort()` 之后旧循环仍要**等满退避时长**才醒
 * ⇒ 「掐断订阅」不是即时的。生产影响：切会话 / 关页后，旧订阅还挂着最长 5s
 * （backoffCapMs），期间它仍可能发起一次重连请求 ⇒ 幽灵订阅。
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

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
  /**
   * 新一轮：掐掉旧流重新挂。
   *
   * ⭐ promise resolve = **订阅已发起并拿到首个响应**（200 / 404 / 401 / 403 / 网络异常
   * 都算「有了结论」），**不是**「流已结束」。常驻订阅下后者永不发生。
   */
  start: () => Promise<void>
  /**
   * 页面可见性恢复：state-aware——
   * idle 直接挂；backoff 等待中掐断重来（跳过排队，冻结期间计时器已停摆）；
   * connecting/streaming 不动（健康流不打断）。
   */
  resume: () => Promise<void>
  abort: () => void
  getState: () => FollowUpTailState
  /**
   * ⭐ 2026-10-26 可观测出口：**当前在途的轮次数量**。
   *
   * 正常值恒为 ≤1（最新轮次胜出）。>1 ⇒ 有旧轮没被掐干净 ⇒ 连接泄漏。
   * 生产事故的判据就是它：同一 thread 出现 6 条并发 SSE。
   */
  getLiveCount: () => number
}

export function createFollowUpTailListener(deps: FollowUpTailDeps): FollowUpTailListener {
  const idleMs = deps.idleMs ?? 45_000
  const maxRounds = deps.maxRounds ?? Number.POSITIVE_INFINITY
  const maxReconnects = deps.maxReconnects ?? 5
  const backoffBaseMs = deps.backoffBaseMs ?? 250
  const backoffCapMs = deps.backoffCapMs ?? 5000
  const reconnectCooldownMs = deps.reconnectCooldownMs ?? 30_000

  let rounds = 0
  let lastSeq: number | null = null
  let state: FollowUpTailState = 'idle'
  /** 当前正在跑的那一轮（null = 没有）。 */
  let current: RunToken | null = null
  /**
   * ⭐ 2026-10-26：**所有**在途轮次。
   *
   * ⛔ 旧实现只有一个 `current` ⇒ 一旦有第二轮覆盖了 `current`，
   *   更早的轮次就**再也掐不掉了**（它们各自还在重连 ⇒ 各自占着一条连接）。
   *   生产实测同一 thread 出现 6 条并发 SSE ⇒ 6 个连接把浏览器槽位吃干。
   *   ⇒ `abort()` 必须能一次掐掉**全部**在途轮次。
   */
  const live = new Set<RunToken>()
  /** 轮次序号（自增）：**最新轮次胜出**，旧轮在循环顶部自杀。 */
  let roundSeq = 0

  function abort(): void {
    for (const token of [...live]) {
      token.stopped = true
      // 掐整轮：退避 / 冷却等待立刻醒来（否则要等满时长 ⇒ 幽灵订阅）。
      token.round.abort()
      // ⭐ 掐掉本轮**全部**在途 attempt（只掐 `attempt` 单字段 ⇒ 旧连接泄漏）。
      for (const ac of token.attempts) ac.abort()
      token.attempt?.abort()
    }
    live.clear()
    current = null
    // 复位状态：否则「start() 掐旧流开新流」时 run() 的 idle 闸门会把新一轮挡住。
    state = 'idle'
  }

  /**
   * 发起一轮订阅；resolve = 首个响应已收到。
   *
   * ⛔ **不 await 循环本体**：常驻订阅的循环在 abort 前永不结束
   *   （clean-end 走重连 ⇒ 唯一终点是 abort / 终态 404 / 401 / 403）。
   *   await 它 = 调用方永久挂起 ⇒ 契约必须是「已就绪」而非「已结束」。
   */
  async function launch(): Promise<void> {
    let mark: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      mark = resolve
    })
    void run(mark)
    await ready
  }

  async function run(onReady: () => void): Promise<void> {
    if (state !== 'idle') {
      // 上一轮还占着（理论上不该发生：start/resume 都会先 abort）⇒ 也要让调用方有结论。
      onReady()
      return
    }
    rounds += 1
    if (rounds > maxRounds) {
      onReady()
      return
    }
    const token: RunToken = {
      stopped: false,
      seq: ++roundSeq,
      round: new AbortController(),
      attempt: null,
      attempts: new Set(),
    }
    current = token
    live.add(token)
    // 累计重连预算：**不因单次连接成功而重置**。若重置，「连上即断」的死循环
    // （每次 HTTP 200、立刻流断）会让预算永远耗不尽——实测 1.4s 内重连 8 次。
    // 轮内退避等级同样随累计次数指数增长（ cap 封顶），健康长流被 idle 闸门收尾。
    //
    // ⭐ 2026-10-24：新增「**健康连接**」豁免——本连接**收到过 data 帧**才允许重置预算。
    // 理由：常驻订阅会周期性地 clean-end（上游 lane 被 TTL 回收 / 网关掐断），
    // 每一次都是「服务端健康地服务了一段然后正常结束」⇒ 不该累计惩罚。
    // 而「连上即断」（零帧）恰恰是死循环的特征 ⇒ 仍必须被预算掐断。
    // 判据落在**可观测出口**（本连接是否产出过 data 帧），不靠时长猜测。
    let reconnects = 0
    try {
      while (!token.stopped) {
        // ⭐ 2026-10-26：最新轮次胜出。若有更新的轮次已经开起来（并发 start/resume），
        //   本轮立即自杀 ⇒ **任何时刻只可能有一条连接在飞**。
        if (token.seq !== roundSeq) {
          token.stopped = true
          token.attempt?.abort()
          break
        }
        state = 'connecting'
        const url = buildObserverStreamUrl(deps.baseUrl(), lastSeq)
        const attempt = new AbortController()
        token.attempt = attempt
        token.attempts.add(attempt)
        // ⭐⭐⭐ 2026-10-26 根因修复：idle 闸门的重置**不得**用 `timer.refresh()`。
        //
        // 生产事故（浏览器实测 7 条并发 SSE）：浏览器里 `setTimeout` 返回 **number**，
        //   `number.refresh()` 不存在 ⇒ 响应头一到、第一次 `idleTimer.refresh()`
        //   就抛 TypeError ⇒ 被 catch 吞掉 ⇒ 立即重连 ⇒ 旧连接未释放 ⇒ 逐程累积。
        //   单测没抓住：vitest fake timers 的 setTimeout 返回模仿 Node 的 Timeout
        //   对象（恰好有 refresh）⇒ 测试全绿、浏览器爆炸（平台差异回归）。
        // ⇒ 改为 clearTimeout + setTimeout 重设（所有平台一致）。
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const armIdle = () => {
          if (idleTimer !== undefined) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => attempt.abort(), idleMs)
        }
        armIdle()
        // 本连接是否产出过 **data 帧**（`: observer-ready` 这类注释帧不算——
        // 它只证明「连上了」，不证明「服务端服务了一段」）。
        let sawData = false
        /** 本程的 body reader：finally 里**必须** cancel（见 TailReaderLike.cancel 注释）。 */
        let reader: TailReaderLike | null = null
        try {
          const res = await deps.fetchImpl(url, {
            headers: deps.headers(),
            signal: attempt.signal,
          })
          // 首个响应已到 ⇒ 订阅「已就绪」（不论状态码）。
          onReady()
          // 404 = 会话已删除（pi-runtime 语义）；401/403 = 鉴权失效（token 过期 / 被登出）。
          // 两者重连都无意义（重连只会再拿一次同样的状态码）⇒ 直接退，避免重连风暴。
          if (res.status === 404 || res.status === 401 || res.status === 403) return
          if (!res.ok || !res.body) throw new Error(`observer stream HTTP ${res.status}`)
          armIdle()
          state = 'streaming'
          reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''

          while (true) {
            // ⭐ 轮次被更新一轮取代 / 被显式终止 ⇒ 立刻退出（finally 统一 cancel 释放连接）。
            //   ⛔ 旧实现只在**外层**循环顶检查 ⇒ 已进入读循环的轮次对「被取代」无感知，
            //     连接一直挂到服务端/网关掐断为止。
            if (token.stopped || token.seq !== roundSeq) break
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const { frames, rest } = extractSseFrames(buffer)
            buffer = rest
            for (const frame of frames) {
              // 批次中途被 abort（新一轮开始）⇒ 剩余帧不再处理，避免旧流尾巴
              // 在新流已开之后又追加一段文本。
              if (attempt.signal.aborted) break
              // 任何帧（含心跳与就绪注释帧）都刷新 idle：常驻订阅的寿命由服务端决定，
              // 前端闸门只兜「服务端彻底静默」。旧契约「只认业务事件」是为 tail 设计的
              // （有硬上限），常驻化后若沿用，静默会话会被前端自己 20s 掐断。
              armIdle()
              // 游标先落帧：哪怕 payload 解析失败也不丢断点位置
              const seq = parseSseFrameSeq(frame)
              if (seq !== undefined) lastSeq = seq
              const line = frame.split('\n').find((l) => l.startsWith('data:'))
              if (!line) continue
              // 「服务端确实服务了一段」的判据：**收到过 data 帧**。
              // 注释帧（`: observer-ready`）只证明连上了，不证明服务过 ⇒ 不算健康。
              sawData = true
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
          // 服务端 clean end：**也要重连**（2026-10-24 语义修正）。
          //
          // ⛔ 旧语义「clean end = 正常收尾，不重连，等下一轮」是**为旧 tail 契约**
          // （turn 收尾后的派生一代，有硬上限）写的。常驻化之后它是错的：
          // 服务端 clean end 现在有三种成因——① 上游 lane 被回收后的正常收尾；
          // ② 网关/代理掐断（nginx 300s 读超时）；③ 服务端异常收尾。
          // 三者都**不代表「没有更多事件了」**⇒ 一律 return 就等于「永久失联」，
          // 直到用户切走再切回（visibilitychange）或刷新页面。
          // ⇒ 这正是用户主诉「刷新后才同步」的直接成因之一：
          //   旁听端早就退出了，刷新才重新挂上并拉到权威历史。
          //
          // ⚠️ 重连预算**不重置**（连上即断的死循环必须能被预算掐断），
          //   但**健康连接豁免**：收到过 data 帧 ⇒ 服务端确实服务了一段（健康），
          //   此时把预算归零，让「周期性 clean-end 的常驻订阅」能一直续上；
          //   零帧的「连上即断」不豁免 ⇒ 死循环仍被预算掐断。
          if (sawData) reconnects = 0
          reconnects += 1
          if (reconnects > maxReconnects) {
            // 预算耗尽 ≠ 终态：冷却后重开一轮新预算（常驻订阅不许永久失联）。
            state = 'backoff'
            await delay(reconnectCooldownMs, token.round.signal)
            if (token.stopped) return
            reconnects = 0
            continue
          }
          state = 'backoff'
          await delay(backoffWithJitter(backoffBaseMs, backoffCapMs, reconnects), token.round.signal)
        } catch {
          // 显式终止是预期退出，不走重连分支。
          if (token.stopped) return
          // fetch 抛错也算「已就绪」（调用方拿到了结论：订阅没能建立）。
          onReady()
          // ⚠️ 异常路径（网络断/非 2xx/**idle 闸门触发**）**不**豁免预算：
          //   这类断连往往就是「连上即断」死循环的形态，必须让预算能掐断它。
          //   ⭐ idle 闸门也走这里 ⇒ idle **不再是终止**，只是「换一程继续听」。
          reconnects += 1
          if (reconnects > maxReconnects) {
            state = 'backoff'
            await delay(reconnectCooldownMs, token.round.signal)
            if (token.stopped) return
            reconnects = 0
            continue
          }
          state = 'backoff'
          await delay(backoffWithJitter(backoffBaseMs, backoffCapMs, reconnects), token.round.signal)
        } finally {
          if (idleTimer !== undefined) clearTimeout(idleTimer)
          token.attempts.delete(attempt)
          token.attempt = null
          // ⭐ 连接卫生：无论 done / 异常 / abort / 换程，都要显式释放流 ⇒
          //   关闭底层连接。cancel 对已结束的流是安全 no-op（可能 reject，吞掉即可）。
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
      }
    } finally {
      live.delete(token)
      // 只清理「自己还是当前轮」：被新一轮 abort 掉旧轮时，finally 慢一步
      // 会把新轮的引用清掉（visibility 重挂路径会触发这个竞态）。
      if (current === token) {
        current = null
        state = 'idle'
      }
    }
  }

  return {
    start: async () => {
      abort()
      await launch()
    },
    resume: async () => {
      if (state === 'idle') {
        await launch()
        return
      }
      if (state === 'backoff') {
        // 冻结期间退避计时器可能已停摆 ⇒ 掐断重来，游标续传不丢不重放
        abort()
        await launch()
      }
      // connecting / streaming：健康流不打断
    },
    abort,
    getState: () => state,
    getLiveCount: () => live.size,
  }
}
