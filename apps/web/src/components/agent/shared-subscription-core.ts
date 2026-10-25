/**
 * 订阅共享的**纯函数层**（2026-10-26 规格 §8）。
 *
 * 为什么单独一个文件：选举、接管判定、游标合并、帧过滤这四件事**必须能单测**——
 * 它们决定「哪个标签页持有连接」与「帧会不会重复/倒退」，一旦出错就是
 * 多端同步静默失真（最难查的一类故障）。
 * ⚠️ 纪律：这层**不许**出现 `Date.now()` / `new BroadcastChannel()` / 任何 IO
 * ——时钟与频道一律由调用方注入（规格 G-6）。
 */

/**
 * 选举 leader：同伴里 **tabId 字典序最小**者当选。
 *
 * 为什么用确定性规则而不是"谁先到谁当"：
 * - 确定性 ⇒ 所有标签页**各自算出同一个答案** ⇒ 不需要协商往返，也不会两人同时自认；
 * - 字典序比较是**全序** ⇒ 不存在"平局"分支。
 *
 * @param tabIds 存活且可见的候选（含自己）
 * @returns leader 的 tabId；空数组 ⇒ null（无人可当）
 */
export function electLeader(tabIds: string[]): string | null {
  if (!tabIds.length) return null
  let best = tabIds[0]!
  for (const id of tabIds) {
    if (id < best) best = id
  }
  return best
}

/**
 * leader 失联判定：**严格大于**阈值才算失联（等于阈值仍视为活着）。
 *
 * ⚠️ 边界取「严格大于」而不是「≥」：心跳按固定周期发，判定窗口若与心跳周期
 * 恰好相等，会在正常情况下周期性误判 ⇒ 触发不必要的接管（多开一条连接 ⇒
 * 反而加剧 6 连接拥挤）。
 */
export function shouldTakeOver(args: {
  lastPongAt: number
  now: number
  timeoutMs: number
}): boolean {
  return args.now - args.lastPongAt > args.timeoutMs
}

/**
 * 游标合并：取两者的**较大值**；`null` 视为"未知"，不参与比较。
 *
 * ⚠️ 游标只能前进：回退会让服务端**全量重放**（`afterSeq=-1` 分支），
 * 表现为对话流里旧内容整段重复刷屏（`observer-stream.ts` 头注释记录的已知坑）。
 */
export function mergeCursor(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return a > b ? a : b
}

/** 带序号的一帧（事件 + 序号）。 */
export interface SeqFrame<T> {
  seq: number
  ev: T
}

/**
 * 帧过滤：**丢弃已消费过**的帧（`seq <= lastSeq`），保证下游只看到新帧。
 *
 * 为什么需要：BroadcastChannel 可能重复投递（重连后重放）或乱序投递；
 * 直接把收到的帧喂给宿主 ⇒ 文本重复。
 */
export function planFrames<T>(frames: SeqFrame<T>[], lastSeq: number): SeqFrame<T>[] {
  return frames.filter((f) => f.seq > lastSeq)
}

/**
 * **谁该真正开订阅连接**（唯一判据，接线处必须走它 —— 不要在组件里另写一份）。
 *
 * - `degraded`（无 BroadcastChannel / 异常）⇒ **各自订阅**（= 改动前行为）⇒ `true`；
 * - 否则**只有可见的 leader** 才开连接：
 *   · follower 开 ⇒ 回到「N 个标签页 N 条长连接」的病态（本次根治的靶子）；
 *   · 隐藏页开 ⇒ 违反 `#587`（「看不见就不该占着连接」）。
 */
export function shouldOpenConnection(state: {
  degraded: boolean
  isLeader: boolean
  visible: boolean
}): boolean {
  if (state.degraded) return true
  return state.isLeader && state.visible
}
