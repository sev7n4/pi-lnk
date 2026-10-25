/**
 * 会话级订阅的**跨标签页共享**（2026-10-26 规格 §5 · 根治「6 连接被订阅占满」）。
 *
 * ## 为什么存在（生产事故，不是设想）
 * 2026-10-26 生产实测：品牌页点锚 → 15 秒 →「项目加载失败 · 重试」，重试无效。
 * DevTools：4 条 `GET /api/agent/canvas/list` 全部 15s 超时被取消、**已传输 0 B**；
 * 同一时段 nginx access.log **零条** ⇒ 请求**根本没离开浏览器**（排在浏览器的连接队列里）。
 *
 * 占用方 = 会话级常驻订阅（`#574` 起，每标签页一条长连接，靠服务端心跳维持，
 * 实测 30s+ 不关闭）× **Chrome 同源 HTTP/1.1 的 6 连接硬上限**
 * ⇒ 标签页一多，普通请求全部排队饿死。
 *
 * ⛔ 曾经的错误药方「nginx 开 http2」**无效**：站点是明文 HTTP，`listen ... http2`
 * 只启用 h2c，而**浏览器只在 TLS 上用 h2**（实测 `curl --http2-prior-knowledge` 服务端
 * 是 HTTP/2，浏览器路径拿不到）。真正的结构性解法是 HTTPS + h2（后续包）。
 *
 * ## 本模块做什么
 * 同一浏览器、同一会话的 N 个标签页 ⇒ **全局只保留 1 条**订阅连接：
 * - **leader** 标签页持有真正的 SSE，并把语义事件转发给其他标签页；
 * - **follower** 标签页**不发起任何订阅请求**，只收转发；
 * - leader 死亡（心跳超时）⇒ follower 接管；
 * - 任何异常（无 BroadcastChannel / 选举异常）⇒ **降级为「各自订阅」**（= 改动前行为）。
 *
 * ## 为什么不侵入 `follow-up-tail.ts`
 * 订阅模块的判定逻辑（游标、退避预算、idle 闸门、clean-end 重连、404/401/403 终态）
 * **一行不改**（规格 G-2）。共享发生在**语义事件层**
 * （`text_delta` / `canvas_action` / `turn_end`）——这三个回调本来就由宿主
 * （`AgentSideRail.vue`）提供，宿主同时把事件**本地应用**并**广播**即可。
 *
 * ## 帧缺口自愈
 * BroadcastChannel **不是可靠通道** ⇒ 事件带**单调广播序号** `n`；
 * follower 发现 `n > lastN + 1` ⇒ 请求 `replay(from=lastN+1)`，
 * leader 从环形缓冲补发 ⇒ 丢帧可自愈（R-C / G-4：序号只增不减）。
 */

import {
  electLeader,
  mergeCursor,
  planFrames,
  shouldOpenConnection,
  shouldTakeOver,
} from './shared-subscription-core'

export type SharedEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'canvas_action'; data: unknown }
  | { kind: 'turn_end' }

/**
 * 频道抽象：**只声明我们用到的那几个成员**。
 *
 * ⚠️ 为什么不用 `onmessage` 属性：`BroadcastChannel.onmessage` 的类型是
 *   `(this: BroadcastChannel, ev: MessageEvent<any>) => any` ⇒ 与自定义的
 *   `(ev: { data: unknown }) => void` 在**严格函数类型**下不兼容（CI 实测 TS2322）。
 *   改用 `addEventListener('message', …)` ⇒ 回调参数按 DOM 事件类型反推 ⇒ 两侧都成立。
 */
export interface SharedChannel {
  postMessage(msg: unknown): void
  close(): void
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void
  removeEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void
}

export interface SharedSubscriptionOptions {
  /** 频道名：同源同会话唯一（调用方按 sessionId+threadId 拼） */
  channelName: string
  /** 本标签页 id（默认随机；测试可注入固定值以确定选举结果） */
  tabId?: string
  /** 频道工厂（测试可替换；返回 null ⇒ 降级） */
  createChannel?: (name: string) => SharedChannel | null
  /** 时钟（测试可注入） */
  now?: () => number
  /** 心跳周期（默认 1000ms） */
  pingIntervalMs?: number
  /** leader 失联判定阈值（默认 3000ms） */
  takeoverTimeoutMs?: number
  /** 收到事件（本地应用） */
  onEvent: (e: SharedEvent) => void
  /** 领导权变化（true = 我是 leader，需要持有连接） */
  onLeadership?: (isLeader: boolean) => void
  /** 降级（无 BroadcastChannel / 异常）⇒ 调用方走「各自订阅」 */
  onDegrade?: (reason: string) => void
  /** 环形缓冲容量（默认 200 条） */
  bufferSize?: number
}

export interface SharedSubscriptionStatus {
  leader: boolean
  peers: number
  broadcastCount: number
  degraded: boolean
  lastEventSeq: number
}

export interface SharedSubscription {
  start(): void
  stop(): void
  /** 可见性切换（隐藏 ⇒ 让出 leader、不占连接；见 #587 与规格 §6 S8） */
  setVisible(visible: boolean): void
  isLeader(): boolean
  status(): SharedSubscriptionStatus
  /** 广播一条语义事件（仅 leader 生效；follower 调用是 no-op） */
  broadcast(ev: SharedEvent): void
}

/** 频道内消息（协议见规格 §7） */
type SharedMessage =
  | { t: 'hello'; tab: string; at: number; vis: boolean }
  | { t: 'ping'; tab: string; at: number; vis: boolean }
  | { t: 'pong'; tab: string; at: number; vis: boolean }
  | { t: 'events'; tab: string; n: number; evs: SharedEvent[] }
  | { t: 'replay'; tab: string; from: number }
  | { t: 'replay_ack'; tab: string; from: number; evs: SharedEvent[] }
  | { t: 'bye'; tab: string }

interface PeerInfo {
  lastSeen: number
  /** 该同伴当前是否可见（隐藏页不该当 leader，也不该占连接 —— #587 语义） */
  visible: boolean
}

function randomTabId(): string {
  return `t${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export function createSharedSubscription(opts: SharedSubscriptionOptions): SharedSubscription {
  const tabId = opts.tabId ?? randomTabId()
  const now = opts.now ?? (() => Date.now())
  const pingIntervalMs = opts.pingIntervalMs ?? 1000
  const takeoverTimeoutMs = opts.takeoverTimeoutMs ?? 3000
  const bufferSize = opts.bufferSize ?? 200
  const createChannel =
    opts.createChannel ?? ((name: string) => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name)))

  /** 频道消息序号（广播单调，follower 用它发现缺口） */
  let broadcastCount = 0
  /** follower 已消费到的序号 */
  let lastEventSeq = 0
  /** leader 的环形缓冲（序号 → 事件），供 replay 补发 */
  const buffer = new Map<number, SharedEvent>()
  /** 已知同伴：tabId → 最后一次见到它的时间 */
  const peers = new Map<string, PeerInfo>()
  let channel: SharedChannel | null = null
  let messageHandler: ((ev: { data: unknown }) => void) | null = null
  let degraded = false
  /** 本标签页是否可见（隐藏 ⇒ 让出 leader、不占连接；见 #587） */
  let visible = true
  let leader = false
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  function alivePeers(nowTs: number): string[] {
    const ids: string[] = []
    if (visible) ids.push(tabId)
    for (const [id, info] of peers) {
      if (!info.visible) continue
      if (nowTs - info.lastSeen <= takeoverTimeoutMs) ids.push(id)
    }
    return ids.sort()
  }

  function currentLeader(nowTs: number): string | null {
    const ids = alivePeers(nowTs)
    return ids.length ? electLeader(ids) : null
  }

  function refreshLeadership(): void {
    const nowTs = now()
    const next = currentLeader(nowTs) === tabId
    if (next === leader) return
    leader = next
    opts.onLeadership?.(leader)
  }

  function post(msg: SharedMessage): void {
    if (!channel) return
    try {
      channel.postMessage(msg)
    } catch {
      /* 频道异常 ⇒ 忽略（R-D：降级优先于失败） */
    }
  }

  function applyLocal(evs: SharedEvent[]): void {
    for (const ev of evs) {
      try {
        opts.onEvent(ev)
      } catch {
        /* 宿主回调异常不得影响共享层 */
      }
    }
  }

  /** leader 广播：分配序号 + 记缓冲 + 本地应用 + 发出去 */
  function broadcast(ev: SharedEvent): void {
    if (!leader || degraded || stopped) return
    broadcastCount += 1
    buffer.set(broadcastCount, ev)
    // 环形缓冲：超出容量就丢最旧的（Map 保插入序）
    while (buffer.size > bufferSize) {
      const oldest = buffer.keys().next()
      if (oldest.done) break
      buffer.delete(oldest.value)
    }
    lastEventSeq = broadcastCount
    // ⚠️ **不在这里本地应用**：leader 自己的事件已由宿主（订阅回调）应用过，
    //   再应用一次 ⇒ 文本双份。广播的职责只是「转给其他标签页」。
    post({ t: 'events', tab: tabId, n: broadcastCount, evs: [ev] })
  }

  function handleMessage(raw: unknown): void {
    const msg = raw as SharedMessage
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return
    const ts = now()
    if (msg.t === 'hello') {
      peers.set(msg.tab, { lastSeen: ts, visible: msg.vis !== false })
      // 回一声 hello，让新加入者认识我
      post({ t: 'hello', tab: tabId, at: ts, vis: visible })
      refreshLeadership()
      return
    }
    if (msg.t === 'ping') {
      peers.set(msg.tab, { lastSeen: ts, visible: msg.vis !== false })
      post({ t: 'pong', tab: tabId, at: ts, vis: visible })
      refreshLeadership()
      return
    }
    if (msg.t === 'pong') {
      peers.set(msg.tab, { lastSeen: ts, visible: msg.vis !== false })
      refreshLeadership()
      return
    }
    if (msg.t === 'events') {
      if (msg.tab === tabId) return
      peers.set(msg.tab, { lastSeen: ts, visible: true })
      refreshLeadership()
      // 只接受**当前 leader** 的转发（脑裂保护：两个 leader 时只认选举结果那个）。
      // ⛔ 判据是「发送者是不是当前 leader」，**不是**「我自己是不是 leader」——
      //   后者会让 follower 把所有事件都丢掉（接收方不是 leader，恰恰是常态）。
      const leaderId = currentLeader(ts)
      if (leaderId !== msg.tab) return
      if (leader) return // 我自己是 leader：自己的事件已在本地应用过
      const startSeq = msg.n - msg.evs.length + 1
      const gap = startSeq > lastEventSeq + 1
      if (gap) {
        // ⛔ 缺帧 ⇒ **先补齐再应用**：直接应用新帧会让文本乱序（增量片段顺序错乱）。
        //   请求 leader 从我已消费到的位置补发；补帧到达前不应用任何新帧。
        //   （极端情况：leader 的环形缓冲已淘汰 ⇒ 补帧为空 ⇒ 文本可能缺一小段，
        //     但回合收尾的 `reconcileLatestAssistant(0)` 会用**服务端权威历史**纠正 ⇒ 可接受。）
        post({ t: 'replay', tab: tabId, from: lastEventSeq + 1 })
        return
      }
      const fresh = planFrames(
        msg.evs.map((ev, i) => ({ seq: startSeq + i, ev })),
        lastEventSeq,
      )
      if (!fresh.length) return
      lastEventSeq = mergeCursor(lastEventSeq, msg.n) ?? lastEventSeq
      applyLocal(fresh.map((f) => f.ev))
      return
    }
    if (msg.t === 'replay') {
      if (!leader) return
      const evs: SharedEvent[] = []
      for (const [n, ev] of buffer) {
        if (n >= msg.from) evs.push(ev)
      }
      post({ t: 'replay_ack', tab: tabId, from: msg.from, evs })
      return
    }
    if (msg.t === 'replay_ack') {
      if (leader) return
      const evs = msg.evs ?? []
      if (!evs.length) return
      applyLocal(evs)
      // 游标推进到补帧的最后一帧（seq 连续 ⇒ from + len - 1）
      lastEventSeq = mergeCursor(lastEventSeq, msg.from + evs.length - 1) ?? lastEventSeq
      return
    }
    if (msg.t === 'bye') {
      peers.delete(msg.tab)
      refreshLeadership()
    }
  }

  function tick(): void {
    const ts = now()
    // 心跳：宣告自己活着，并让同伴知道我还活着
    post({ t: 'ping', tab: tabId, at: ts, vis: visible })
    // 清理早已失联的同伴（超过两倍阈值）
    for (const [id, info] of peers) {
      if (ts - info.lastSeen > takeoverTimeoutMs * 2) peers.delete(id)
    }
    const before = leader
    refreshLeadership()
    // leader 失联 ⇒ 我成为新 leader（onLeadership 通知宿主去开连接）
    if (before !== leader) {
      // 已在 refreshLeadership 里通知过
    }
  }

  function start(): void {
    if (stopped) return
    let ch: SharedChannel | null = null
    try {
      ch = createChannel(opts.channelName)
    } catch {
      ch = null
    }
    if (!ch) {
      // R-D：没有共享能力 ⇒ 降级到「各自订阅」（= 改动前行为），不得抛错
      degraded = true
      opts.onDegrade?.('no-channel')
      return
    }
    channel = ch
    try {
      messageHandler = (ev: { data: unknown }) => {
        try {
          handleMessage(ev.data)
        } catch {
          /* 任何消息处理异常都不许影响主流程 */
        }
      }
      channel.addEventListener('message', messageHandler)
    } catch {
      degraded = true
      opts.onDegrade?.('channel-error')
      return
    }
    post({ t: 'hello', tab: tabId, at: now(), vis: visible })
    timer = setInterval(tick, pingIntervalMs)
    refreshLeadership()
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    post({ t: 'bye', tab: tabId })
    if (channel) {
      try {
        if (messageHandler) channel.removeEventListener('message', messageHandler)
        channel.close()
      } catch {
        /* 关闭异常忽略 */
      }
      channel = null
      messageHandler = null
    }
    peers.clear()
  }

  /**
   * 可见性切换（`#587` 在共享下的落点）。
   *
   * - 变隐藏 ⇒ **让出 leader**（`onLeadership(false)` ⇒ 宿主掐掉连接）
   *   并退出选举候选 ⇒ 可见的同伴才能接管；
   * - 变可见 ⇒ 重新参与选举（可能当选 ⇒ 宿主开连接）。
   */
  function setVisible(v: boolean): void {
    if (visible === v) return
    visible = v
    if (!visible) {
      if (leader) {
        leader = false
        opts.onLeadership?.(false)
      }
      // 隐藏后不再当候选：把 peers 里"自己"的记录清掉（自己不会出现在 peers 里）
      refreshLeadership()
      return
    }
    refreshLeadership()
  }

  return {
    start,
    stop,
    setVisible,
    isLeader: () => leader,
    status: () => ({
      leader,
      peers: peers.size,
      broadcastCount,
      degraded,
      lastEventSeq,
    }),
    broadcast,
  }
}

export { electLeader, mergeCursor, planFrames, shouldOpenConnection, shouldTakeOver }
