/**
 * 旁听流的纯函数层（multi-device Task 5）。
 *
 * 拆分动机：AgentSideRail.vue 的 `listenFollowUpTail` 是「fetch + 手工 SSE 解析」
 * （要带 auth 头，用不了浏览器 EventSource 的自动续传）。把帧切分、id 解析、
 * 游标 URL 构造抽成纯函数 ⇒ 回归锁落在**可观测出口**（帧字符串 / URL 字符串），
 * 不依赖挂载整个侧栏组件。
 *
 * Task 4 的下游：Nest 现在给带 seq 的帧写 `id:` 行，本模块负责在断线重连时
 * 把最后见到的 seq 拼回 `lastEventId`（Review Focus #1：只补增量不重放）。
 */

/** 把 buffer 切成完整帧（`\n\n` 分隔），剩余半帧留在 rest 等下一块网络数据。 */
export function extractSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  let rest = buffer
  let sep: number
  while ((sep = rest.indexOf('\n\n')) !== -1) {
    frames.push(rest.slice(0, sep))
    rest = rest.slice(sep + 2)
  }
  return { frames, rest }
}

/**
 * 从一帧里取 `id:` 行的数字游标；无 id 行或非数字返回 undefined。
 *
 * ⚠️ 非数字/负值一律 undefined：pi-runtime 用 `Number.isInteger` 判定
 * `resolveEventsSubscribeMode`，NaN 会落进 `replay afterSeq=-1` **全量重放**分支
 * （plan 已知坑）——比丢一帧严重得多。
 */
export function parseSseFrameSeq(frame: string): number | undefined {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('id:')) continue
    const raw = line.slice(3).trim()
    if (!/^\d+$/.test(raw)) return undefined
    const n = Number(raw)
    return Number.isInteger(n) && n >= 0 ? n : undefined
  }
  return undefined
}

/**
 * 重连 URL 构造：**只在有游标时**拼 `lastEventId`。
 *
 * ⚠️ null 时不得拼 `lastEventId=`（空值）：pi-runtime 的畸形值分支是全量重放，
 * 会把上一轮整个 buffer 重新推一遍 ⇒ 文本重复刷屏（plan 已知坑）。
 */
export function buildObserverStreamUrl(baseUrl: string, lastSeenSeq: number | null): string {
  if (lastSeenSeq === null) return baseUrl
  return `${baseUrl}&lastEventId=${lastSeenSeq}`
}
