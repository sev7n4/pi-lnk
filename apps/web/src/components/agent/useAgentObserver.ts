import { type Ref, ref, watch, onMounted, onUnmounted } from 'vue'
import type { CreditTxEvent } from '@lnkpi/shared'
import { apiUrl } from '@/services/api-base'
import { connectPointEvents, type PointEventsConnection } from '@/services/points-events'
import { createFollowUpTailListener, isTurnTerminal } from './follow-up-tail'
import { applyTailVisibility } from './tail-visibility'
import {
  createSharedSubscription,
  shouldOpenConnection,
  type SharedEvent,
  type SharedSubscription,
} from './shared-subscription'
import type { useAgentStore } from '@/stores/agent'

type AgentStore = ReturnType<typeof useAgentStore>

/**
 * 第十刀（strangler-fig，2026-11-08）：旁听 / 常驻 SSE 订阅簇从 AgentSideRail 抽离。
 *
 * 所有权边界（沿用前序刀原则）：`agentThreadId` 仍由父组件持有并注入（父内 send / fork /
 * rerun 等约 129 处读取零改动），此处只注入并消费。composable 承载「挂载即订阅 +
 * 跨标签页共享槽位 + 旁观轮语义应用 + ack 化主流终态收口 + 余额广播」这一组内聚职责，
 * 函数体逐字搬运以保证零行为变化。`emit` 不可在 composable 内直接调用，故画布动作 /
 * 回合完成两条 emit 经回调注入（`emitCanvasActions` / `emitTurnComplete`）。
 */
export interface AgentObserverDeps {
  agentThreadId: Ref<string>
  getSessionId: () => string
  agent: AgentStore
  handleEvent: (event: { type: string; data: unknown }) => void
  reconcileLatestAssistant: (maxPolls?: number, outOfTurnShadow?: string | null) => Promise<void>
  mainTurnSuspended: Ref<boolean>
  runCancelled: Ref<boolean>
  scrollToBottom: (force?: boolean) => void
  authHeaders: () => Record<string, string>
  emitCanvasActions: (parts: unknown[]) => void
  emitTurnComplete: () => void
  setPoints: (balanceAfter: number) => void
  /**
   * ⭐ P1b（事件一等化换读，plan 2026-11-11-sse-event-firstclass-p1b-swap-read.md §1.2）：
   * **拉一次服务端权威历史**——快照重同步（pi buffer 溢出 409）后补断连期缺口。
   * 宿主实现 = 组件 `loadHistory()`（no-store 拉 messages + `agent.loadHistory` 重放，
   * 自带单飞与 merge 幂等）。是否可拉由 composable 内守卫（见 followUpTail 装配处），
   * 本回调只管「拉」本身。
   */
  reloadAuthoritativeHistory: () => void
}

export interface AgentObserverApi {
  observerTurnActive: Ref<boolean>
  ownTurnViaObserver: Ref<boolean>
  releaseObserverTurn: () => void
  listenFollowUpTail: () => Promise<void>
  followUpTail: ReturnType<typeof createFollowUpTailListener>
}

export function useAgentObserver(deps: AgentObserverDeps): AgentObserverApi {
  const {
    agentThreadId,
    getSessionId,
    agent,
    handleEvent,
    reconcileLatestAssistant,
    mainTurnSuspended,
    runCancelled,
    scrollToBottom,
    authHeaders,
    emitCanvasActions,
    emitTurnComplete,
    setPoints,
    reloadAuthoritativeHistory,
  } = deps
  let pointEventsConn: PointEventsConnection | null = null

const observerTurnActive = ref(false)

/**
 * ⭐ 多端一致性 P1（计划 2026-11-04 Task 5）：本端主流已并入 GET /runs/events 通道
 * （POST 返回 JSON ack、run 由服务端后台 drain）。置位期间：
 *  - 订阅流的全量事件走 handleEvent（proposal / ask_user / task_* 等完整语义，
 *    与 off 模式 POST 响应体流同一口径——这是「两端同源」的消费面收敛点）；
 *  - 终态事件（done/turn_ack/error/turn_not_submitted）由 finishOwnTurnViaObserver
 *    收口（off 模式的 finally 收尾职责在此对位）；
 *  - 断线由订阅循环自带退避 + 游标续传自愈（不再依赖 POST 连接存活）。
 * 终态收口后复位。旁观模式（false）保持既有最小面（text_delta/canvas_action/终态）。
 */
const ownTurnViaObserver = ref(false)

/**
 * 旁观影子气泡的本地 id（2026-11-03 黄小龙虾复测）。
 *
 * 收尾对账要区分两种影子：**回合外简报**（runtime 主动开的简报轮，服务端落
 * `metadata.outOfTurn` 行）与**多端回合回声**（另一端用户 turn）。前者若走旧的
 * 「最后用户回合第一条 assistant」内容补写，主轮回答必然比简报长 ⇒ `shouldApply...`
 * 判定替换 ⇒ 简报文字被冲掉（黄小龙虾生产实证：影子闪现即被覆盖）。
 * 记住影子 id，收尾时优先按服务端权威行**原位采纳**（见 reconcileLatestAssistant）。
 */
const outOfTurnShadowId = ref<string | null>(null)

/**
 * ⭐ 2026-10-26 根治：把「语义事件的应用」从订阅回调里**抽成独立函数**。
 *
 * 为什么抽：跨标签页共享转发的是**语义事件**（文本增量 / 画布动作 / 回合收束），
 * 而订阅模块的判定逻辑（游标 / 退避 / idle 闸门 / 终态）**一行不改**（规格 G-2）
 * ⇒ 共享必须落在**宿主回调**这一层 ⇒ 「直连收到」与「共享转发收到」要**同一段代码**，
 * 否则两边语义会漂移（历史事故模式）。
 */

/** 应用文本增量（本地）——直连与跨标签页两条路径共用。 */
function applyTextDelta(text: string): void {
  // ⛔ 本端主流在跑：同一份 text_delta 已经从 POST 响应体到了，旁听再追加就是双倍文本。
  if (agent.isStreaming) return
  if (!observerTurnActive.value) {
    // turn_suspended（2026-10-31 皮皮虾回合）：挂起回合的续跑事件属于**本端自己**那条
    // assistant 消息（主流在等待边界收尾、run 仍在跑）——采纳原消息为旁观轮即可，
    // **不得**开影子气泡（否则续写文本会重复冒出第二条气泡）。turn_end 时经
    // reconcileLatestAssistant 以服务端权威历史收口（等待 part 终态一并翻正）。
    if (mainTurnSuspended.value) {
      const last = agent.messages[agent.messages.length - 1]
      if (last?.role === 'assistant') {
        agent.isStreaming = true
        observerTurnActive.value = true
      }
    } else {
      // 旁观另一端的那一轮：本地还没有这条 assistant 的影子 ⇒ 先起一条再追加。
      agent.startAssistantMessage()
      agent.isStreaming = true
      observerTurnActive.value = true
      // 记住影子 id：收尾对账按服务端权威行原位采纳（回合外简报 ≠ 多端回声，
      // 区分依据与守卫见 outOfTurnShadowId 注释）。
      outOfTurnShadowId.value = agent.messages[agent.messages.length - 1]?.id ?? null
    }
  }
  // 与主流的事件契约完全一致（Nest 两端共用 mapPiEventToUiEvent）。
  agent.appendText(text)
  scrollToBottom()
}

/** 应用画布动作（本地）——直连与跨标签页两条路径共用。 */
function applyCanvasAction(data: unknown): void {
  emitCanvasActions([data as never])
}

/** 回合收束（本地）——直连与跨标签页两条路径共用。 */
function applyTurnEnd(): void {
  // 幂等：done 之后还有 turn_ack，会来第二次
  if (!observerTurnActive.value) return
  observerTurnActive.value = false
  // turn_suspended 生命周期闭合：挂起回合已收口（等待解除/超时取消均到达 terminal 帧）
  mainTurnSuspended.value = false
  agent.finishStreaming()
  // 影子 id 移交对账（之后清零：幂等的第二次 done/turn_ack 不再重走采纳）。
  const shadowId = outOfTurnShadowId.value
  outOfTurnShadowId.value = null
  // 旁观拿到的是增量片段，收尾必须以服务端权威历史为准纠正一次（漏帧/乱序的自愈口）。
  // 传 0：那一轮已在另一端跑完，不做终态轮询（否则旁观端会跟着睡 5s×N）。
  // shadowId：回合外简报按权威行原位采纳（内容启发式会把简报冲掉，见 outOfTurnShadowId）。
  void reconcileLatestAssistant(0, shadowId)
  emitTurnComplete()
  scrollToBottom()
}

/**
 * ⭐ P1（计划 Task 6）：ack 化主流（ownTurnViaObserver）的回合**终态收口**——
 * off 模式 sendMessage finally 的收尾职责在本通道的对位实现。
 *
 * 终态事件（done/turn_ack/error/turn_not_submitted）可能连发多次（done 后还有
 * turn_ack）⇒ 用 ownTurnViaObserver 作幂等闸（首帧收口，后续 no-op）。
 */
function finishOwnTurnViaObserver(): void {
  if (!ownTurnViaObserver.value) return
  ownTurnViaObserver.value = false
  const wasSuspended = mainTurnSuspended.value
  // turn_suspended 生命周期闭合（与 applyTurnEnd 同裁决）
  mainTurnSuspended.value = false
  // 与 off 模式 finally 同口径：挂起回合不是「无文本回复」，补句只对普通空回合
  const last = agent.messages[agent.messages.length - 1]
  // ⭐ P0（fix/observer-refusal-exempt）：发言被拒（turnRefusal≠null，如 steer 并入在跑
  // run）时，正确的「已并入进行中任务」callout 已承载反馈，此处绝不再补误导的「无文本回复」。
  // 否则用户会同时看到两条互相矛盾的文案（产品/架构诊断结论：前端反馈机制建成却未被兜底路径消费）。
  if (
    !runCancelled.value &&
    !wasSuspended &&
    !agent.turnRefusal &&
    last?.role === 'assistant' &&
    !last.content.trim()
  ) {
    agent.appendText('（本轮无文本回复。若还需确认，可再发「确认」；或点「新对话」后重试。）')
  }
  agent.finishStreaming()
  // 服务端权威历史收口（纠偏漏帧/乱序 + canvas 节点 turnComplete→loadSession 对齐）
  void reconcileLatestAssistant()
  emitTurnComplete()
  scrollToBottom()
}

/**
 * ⭐ 跨标签页共享（2026-10-26 根治）：同一会话的 N 个标签页 ⇒ **全局只开 1 条**订阅连接。
 *
 * 为什么必须有：常驻订阅是**每标签页一条长连接**（靠服务端心跳维持，实测 30s+ 不关闭），
 * 而 Chrome 对同源 HTTP/1.1 只有 **6 个连接** ⇒ 标签页一多，普通请求（项目列表等）
 * 全部排队饿死（2026-10-26 生产事故：品牌页点锚卡 15 秒 ⇒「项目加载失败」⇒ 重试无效）。
 *
 * 降级：无 BroadcastChannel（老浏览器）⇒ **各自订阅**（= 改动前行为），零新增故障面。
 */
let sharedSubscription: SharedSubscription | null = null
let sharedChannelName = ''

/**
 * ⭐⭐⭐ 2026-10-26 生产取证：**全局 SSE 槽位（跨标签页、跨画布）**。
 *
 * 事故形态（生产实证，2026-10-26）：
 *   用户同时开着多个画布标签页时，**每个标签页各挂一条**常驻订阅
 *   （不同 session ⇒ 上一版的「同 session 共享」合并不了）
 *   ⇒ 累计到 **6 条** = Chrome 同源 HTTP/1.1 的连接上限
 *   ⇒ 之后**所有**普通请求排队饿死（实测 50 条请求 0 字节传输）：
 *     · 画布载荷 `GET /sessions/:id` 排不上 ⇒ **画布显示为空**
 *     · 积分面板 `GET /membership/points` 排不上 ⇒ **显示「0 积分 + 加载中…」**
 *       （实测服务端 29ms 就返回 119466 ⇒ 界面上的 0 是假 0）
 *
 * ⇒ 这里用**一个与 session/thread 无关的全局频道**选举「谁持有唯一那条订阅连接」：
 *   可见页优先（隐藏页让位，见 #587 语义）⇒ **整个浏览器最多 1 条常驻订阅**
 *   ⇒ 给普通请求留出 5 条槽位。
 *
 * ⚠️ 代价（产品取舍，必须让用户知道）：
 *   多窗口同时打开不同画布时，**只有拿到全局槽位的那一个窗口**有「另一端在跑」的
 *   实时推送；其余窗口降级为「不实时」——这是同源 6 连接硬上限下的必然取舍。
 */
let sseSlotSubscription: SharedSubscription | null = null

/** 本标签页是否持有「全局唯一那条订阅连接」。 */
function holdsGlobalSseSlot(): boolean {
  const slot = sseSlotSubscription
  // 无 BroadcastChannel（老浏览器）⇒ 降级：各自订阅（= 改动前行为），零新增故障面。
  if (!slot || slot.status().degraded) return true
  return slot.isLeader()
}

/** 当前标签页是否可见（隐藏 ⇒ 不占连接、让出 leader —— #587 语义）。 */
function isTabVisible(): boolean {
  return document.visibilityState === 'visible'
}

/**
 * 连接开/关的**唯一判据**（所有触发点都调它：会话 leader 变化 / 全局槽位变化 / 可见性变化）。
 *
 * ⛔ 判定必须在**一处**：多处各判一次 ⇒ 条件漂移 ⇒ 同一时刻出现两条连接。
 */
function evaluateConnection(): void {
  const shared = sharedSubscription
  const degraded = shared?.status().degraded ?? false
  const allowed =
    shouldOpenConnection({
      degraded,
      isLeader: shared?.isLeader() ?? true,
      visible: isTabVisible(),
    }) && holdsGlobalSseSlot()
  if (allowed) {
    // ⛔ 只在真的没有连接时开：`start()` 会掐旧流重开，重复调用 ⇒ 连接抖动。
    if (followUpTail.getState() === 'idle') void followUpTail.start()
  } else {
    // 让出 leader / 槽位 / 变隐藏 ⇒ 掐掉本标签页的连接
    followUpTail.abort()
  }
}

/** 取（并启动）全局槽位订阅。 */
function ensureSseSlotSubscription(): SharedSubscription | null {
  if (sseSlotSubscription) return sseSlotSubscription
  sseSlotSubscription = createSharedSubscription({
    // ⭐ 与 session/thread **无关**的固定频道名 ⇒ 所有标签页、所有画布共用一个槽位。
    channelName: 'lnkpi:agent-sse-slot',
    onEvent: () => {},
    onLeadership: () => {
      evaluateConnection()
    },
    onDegrade: () => {
      evaluateConnection()
    },
  })
  sseSlotSubscription.start()
  sseSlotSubscription.setVisible(isTabVisible())
  return sseSlotSubscription
}

/** 取（或按会话/线程重建）共享订阅。 */
function ensureSharedSubscription(): SharedSubscription | null {
  const name = `lnkpi:agent-sub:${getSessionId()}:${agentThreadId.value}`
  if (sharedSubscription && sharedChannelName === name) return sharedSubscription
  // 会话/线程变了 ⇒ 换频道（不同 threadId 是不同的事实源）
  sharedSubscription?.stop()
  // ⭐⭐ 2026-10-26 生产取证修复：**换频道时必须掐掉旧连接**。
  //
  // 事故形态：同一画布页因 threadId 抖动（bootstrap 解析线程）先后开出 6 条
  //   `/api/agent/runs/events`，全部被服务端挂住（6 = Chrome 同源连接上限）
  //   ⇒ 画布数据请求 `GET /api/sessions/<id>` 排不上 ⇒ **画布显示为空**；
  //     首页 `canvas/list` 15s 超时 ⇒「项目加载失败 · 重试」。
  //
  // 旧代码只 `stop()` 了共享频道，**没掐订阅连接** ⇒ 旧 thread 的 SSE 一直挂着。
  // ⇒ 这里显式 abort：换事实源 ⇒ 旧事实源的连接必须立刻归零。
  followUpTail.abort()
  sharedChannelName = name
  sharedSubscription = createSharedSubscription({
    channelName: name,
    onEvent: (ev: SharedEvent) => {
      if (ev.kind === 'text_delta') applyTextDelta(ev.text)
      else if (ev.kind === 'canvas_action') applyCanvasAction(ev.data)
      else applyTurnEnd()
    },
    onLeadership: () => {
      // ⛔ 只有「该开连接的人」才开：follower / 隐藏页都不得自己开
      //   （follower 开 ⇒ 回到「N 标签页 N 条连接」的病态）。
      //   ⇒ 判定统一走 evaluateConnection()（会话 leader + 全局槽位 + 可见性 三者与）。
      evaluateConnection()
    },
    onDegrade: () => {
      // 无 BroadcastChannel ⇒ 各自订阅（= 改动前行为）
      evaluateConnection()
    },
  })
  sharedSubscription.start()
  sharedSubscription.setVisible(isTabVisible())
  return sharedSubscription
}

const followUpTail = createFollowUpTailListener({
  fetchImpl: (url, init) => fetch(url, init),
  headers: () => authHeaders(),
  // ⭐ P1b（事件一等化换读）：快照重同步（pi buffer 溢出 409 → Nest 合成 snapshot 帧）。
  // 游标丢弃在 follow-up-tail 内部（单点，见 onSnapshotResync dep 注释）；这里只做
  // 「是否拉权威历史」的门：**有本端回合在跑时不拉**——流式中 DB 是半程快照（metadata
  // 在收尾才落全），拉了会把流式气泡冲成残缺；收尾的 finishOwnTurnViaObserver /
  // applyTurnEnd → reconcileLatestAssistant 会以权威历史收口，缺口在那里补。
  // 旁观 / 空闲态直接拉：断连期内容在 DB 是全的（Nest drain 与前端连接无关）。
  // ⚠️ turn_suspended（挂起回合续跑中）同守卫：DB 是半程快照，续跑收尾才落全。
  onSnapshotResync: () => {
    if (!agent.isStreaming && !observerTurnActive.value && !mainTurnSuspended.value) {
      reloadAuthoritativeHistory()
    }
  },
  // 每次连接时求值：threadId 可能在会话中途切换（重跑 fork 出新线程）
  baseUrl: () =>
    apiUrl(
      `/api/agent/runs/events?sessionId=${encodeURIComponent(getSessionId())}&threadId=${encodeURIComponent(agentThreadId.value)}`,
    ),
  // ⭐ P1（计划 Task 5/6）：onEvent 提供后本监听器走**排他全量分派**——
  // ack 化主流（ownTurnViaObserver）的回合经 handleEvent 走与 POST 响应体流
  // 完全相同的事件语义；旁观模式保持既有三回调语义（含跨标签页转发）。
  onEvent: (payload) => {
    if (ownTurnViaObserver.value) {
      // 本端回合：全量事件语义（proposal / ask_user / task_* / credit_tx / …）
      handleEvent(payload)
      // Task 6：终止语义统一为事件终态（不再有 [DONE] —— 本路径根本没有 POST 流）
      if (isTurnTerminal(payload.type)) finishOwnTurnViaObserver()
      return
    }
    // 旁观模式：既有最小面 + 跨标签页转发（leader 才有连接 ⇒ follower 靠广播）
    // ⛔ broadcast 实参形状保持与共享契约测试逐字一致（text / data 裸变量名）
    if (payload.type === 'text_delta') {
      const text = (payload.data as { text?: string } | undefined)?.text ?? ''
      applyTextDelta(text)
      sharedSubscription?.broadcast({ kind: 'text_delta', text })
    } else if (payload.type === 'canvas_action') {
      const data = payload.data
      applyCanvasAction(data)
      sharedSubscription?.broadcast({ kind: 'canvas_action', data })
    } else if (payload.type === 'turn_settled') {
      // 2026-11-04 结算实时性根治（机制 B）：终态帧（done，由 pi agent_end 投影）先于
      // turn_settled 到达——结算块含 quote+settle 两次 DB 往返，agent_end 投影恒抢先
      // ⇒ finishOwnTurnViaObserver 先把 ownTurnViaObserver 翻 false，settle 帧落入本
      // 旁观分支被静默丢弃 ⇒ 摘要「已结算 -N 积分」只在刷新重放后出现（会话
      // cmw1oyqww 实测取证）。结算/扣费是终态后到达的合法权益（退款更是天然回合外）
      // ⇒ 旁观分支同样分发；reducer 覆盖写/txId 去重保证幂等。
      agent.trackTurnSettled(payload.data as Parameters<typeof agent.trackTurnSettled>[0])
    } else if (payload.type === 'credit_tx') {
      agent.trackCreditTx(payload.data as CreditTxEvent['data'])
    } else if (payload.type === 'turn_not_submitted') {
      // P3（Review Focus 1）：结构化拒绝帧桥接进共享通道后观察者也会收到，
      // 但受众=提交者本人（own-turn 分支经 handleEvent 消费）。运行中的 run 与
      // 「第三方消息被拒」无关 ⇒ 旁观不收尾（turn_ack 无此问题：done 已是观察者终态）。
    } else if (isTurnTerminal(payload.type)) {
      applyTurnEnd()
      sharedSubscription?.broadcast({ kind: 'turn_end' })
    }
  },
})

/** 订阅当前会话（幂等：内部先 abort 旧流）。 */
function listenFollowUpTail(): Promise<void> {
  // 未登录不订阅：订阅必须带鉴权头，没 token 时请求只会拿到 401，并连带一轮
  // 无意义的退避重连。守卫放在**入口**（而非各调用点）⇒ 挂载 / 切会话 / 可见性恢复全覆盖。
  if (!hasAuthToken()) return Promise.resolve()
  // ⭐ 先参与全局槽位选举（跨标签页/跨画布只允许 1 条常驻订阅）。
  ensureSseSlotSubscription()
  const shared = ensureSharedSubscription()
  // 判定统一走一处（会话 leader + 全局槽位 + 可见性）。
  evaluateConnection()
  if (shared && !shared.status().degraded) {
    // 共享可用 ⇒ follower 在这里返回即可：它要的事件由 leader 转发过来。
    return Promise.resolve()
  }
  // 降级（无 BroadcastChannel）⇒ 各自订阅（= 改动前行为）
  return Promise.resolve()
}

/** 是否持有可用 token（与 `authHeaders` 同源口径）。 */
function hasAuthToken(): boolean {
  return Boolean(localStorage.getItem('token'))
}

/** 本端要自己发一轮了：先结束旁观轮，再停订阅（避免与主流双份消费）。 */
function releaseObserverTurn(): void {
  if (!observerTurnActive.value) return
  observerTurnActive.value = false
  outOfTurnShadowId.value = null
  agent.finishStreaming()
}

/**
 * 可见性：前台恢复常驻订阅，**后台立刻释放**。
 *
 * ⭐ 2026-10-25：原实现只处理「切回前台」（resume），**从不释放后台订阅** ⇒
 *   每个后台标签页永久占着一条 SSE 长连接（常驻订阅断线 5s 封顶重连、永不放弃）。
 *   Chrome 对单个 host 只有 6 条 HTTP/1.1 连接，后台页一多、再叠加偶发的传输卡死，
 *   前台请求就全部排队饿死（项目抽屉「项目加载中」转不完的成因之一，同批取证）。
 *
 * 切回来不丢内容：`resume()` 带 `lastSeq` 游标续传，只补增量不重放（见
 * `follow-up-tail.ts`）；idle 直接挂、backoff 中跳过排队、健康流不打断。
 */
function onFollowUpTailVisibility(): void {
  const visible = isTabVisible()
  // 共享层：隐藏 ⇒ 让出 leader（不再占连接）；可见 ⇒ 重新参与选举（可能接管）。
  sharedSubscription?.setVisible(visible)
  // ⭐ 全局槽位同样要跟随可见性：隐藏页必须把唯一的订阅连接让给可见页。
  sseSlotSubscription?.setVisible(visible)
  // 策略本身在 `tail-visibility.ts`（依赖可注入 ⇒ 可单测），这里只做接线。
  applyTailVisibility({
    isVisible: () => visible,
    hasAuthToken,
    isMainStreamRunning: () => agent.isStreaming,
    resume: () => {
      // ⛔ 只有「该开连接的人」才 resume —— follower resume 会自己开一条连接 ⇒ 回到病态。
      const shared = sharedSubscription
      const shouldOpen = shared
        ? shouldOpenConnection({ degraded: shared.status().degraded, isLeader: shared.isLeader(), visible })
        : true
      if (!shouldOpen) return
      void followUpTail.resume()
    },
    abort: () => followUpTail.abort(),
  })
}

onMounted(() => {
  document.addEventListener('visibilitychange', onFollowUpTailVisibility)
  // 常驻订阅：打开会话就挂上，与「谁在说话」无关。
  // 本端正在跑主流时（`agent.isStreaming`）不挂——那份内容主流自己会给。
  // 后台标签页（例如「在新标签页打开」）不挂：看不见就不该占着连接，切回来再补。
  if (!agent.isStreaming && document.visibilityState === 'visible') void listenFollowUpTail()
  // Epic 2 Task 9（2026-11-04）：余额事件化 user 广播——所有标签页实时同步余额。
  // 本会话帧同时喂 trackCreditTx（txId 幂等，与流内注入/REST 还原天然去重补帧）；
  // 跨会话帧只驱动余额（严禁计入本会话累计——会话口径按 sessionId 隔离，C3）。
  pointEventsConn = connectPointEvents((ev) => {
    if (ev.type !== 'credit_tx') return
    const data = ev.data as CreditTxEvent['data'] | undefined
    if (!data) return
    if (data.sessionId === getSessionId()) {
      agent.trackCreditTx(data)
    } else if (typeof data.balanceAfter === 'number' && Number.isFinite(data.balanceAfter)) {
      setPoints(data.balanceAfter)
    }
  })
})

// 会话 / 线程切换后重挂：订阅 URL 携带 threadId，线程变了旧流就在听错的对象。
watch(
  [() => getSessionId(), () => agentThreadId.value],
  () => {
    releaseObserverTurn()
    followUpTail.abort()
    if (!agent.isStreaming) void listenFollowUpTail()
  },
)

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onFollowUpTailVisibility)
  // 共享层也要退（离开频道 + 释放 leader 身份）⇒ 别的标签页能立刻接管。
  sharedSubscription?.stop()
  sharedSubscription = null
  sharedChannelName = ''
  // ⭐ 退出全局槽位 ⇒ 别的标签页能立刻接管那条唯一的订阅连接。
  sseSlotSubscription?.stop()
  sseSlotSubscription = null
  followUpTail.abort()
  // Epic 2 Task 9：余额广播连接退订（服务端 close 回调同步清 user emitter）。
  pointEventsConn?.stop()
  pointEventsConn = null
})


  return {
    observerTurnActive,
    ownTurnViaObserver,
    releaseObserverTurn,
    listenFollowUpTail,
    followUpTail,
  }
}
