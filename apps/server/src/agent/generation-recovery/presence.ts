/**
 * 在线态代理（spec §6.0-1）：runs/events 旁听流的 lastSeenAt 内存窗口。
 *
 * ⚠️ 双键约定（PR3 实现期修正）：`agent.controller.runEvents` 会**同时**记录
 * `sessionId` 与 `threadId`（前端旁听流通常带 threadId 订阅，而生成失败发射点
 * 只知道 canvas sessionId —— 若只记单键，在线判定恒 false，回注会全部 skip）。
 */
const lastSeen = new Map<string, number>()
const FIVE_MINUTES_MS = 5 * 60 * 1000

export function recordSessionSeen(sessionKey: string, at: number = Date.now()): void {
  lastSeen.set(sessionKey, at)
}

export function isSessionOnline(
  sessionKey: string,
  now: number = Date.now(),
  windowMs: number = FIVE_MINUTES_MS,
): boolean {
  const seen = lastSeen.get(sessionKey)
  if (seen === undefined) return false
  return now - seen <= windowMs
}

export function __resetPresenceForTest(): void {
  lastSeen.clear()
}
