/**
 * P0-4 客户端写守卫（共享纯函数）——pending_confirm 节点的客户端 status 出口白名单。
 *
 * 背景：
 * - 2026-10-13 虚假确认事故（cmv51vwpu0008p801hxaxcf8m）：浏览器整份 PUT 把服务端
 *   pending_confirm 盖回旧终态 completed，runtime 轮询误读为「已确认自起生成」。
 * - 2026-10-30 P0-4 收紧（规格 2026-10-30-propose-confirm-execution-unity §7）：
 *   确认后由服务端自起生成，客户端 PUT 不再需要写 draft——旧放行是给
 *   「前端确认后自起生成」让路的历史残留，正是 2026-10-29 生产事故（画布页 3s
 *   自动整份 PUT 反复把 pending_confirm 盖回 draft）的权限面。取消语义走
 *   /answers decline → clear-propose 内部通道，不经本守卫。
 *
 * P1-C C0（规格 2026-11-02-p1c-write-path-governance-design §4.1）：
 * 守卫原本只挂 sessions 面整份 PUT，`PUT /agent/canvas/update`（canvas.service.update）
 * 是零守卫旁路（当前 web 仅 title 载荷，未被利用，但契约上任何持 token 客户端可整份
 * 提交绕过 P0-4）。本文件把守卫抽成共享纯函数，两面共用同一实现——**禁止漂移**。
 *
 * 语义：pending_confirm 节点的客户端 status 只允许合法出口
 * （pending_confirm 幂等 / generating 服务端已自起的既成事实）；
 * 终态一律无权直达；违规**字段级**保留服务端值 pending_confirm
 * （其余字段照常落库，不 409 整单）。
 */

/** pending_confirm 的合法客户端出口集合。 */
export const PENDING_CONFIRM_CLIENT_EXITS: ReadonlySet<string> = new Set([
  'pending_confirm',
  'generating',
])

type GuardCanvas = { nodes?: Array<{ id?: string; data?: Record<string, unknown> }> }

/**
 * 对客户端整份提交的画布做字段级 pending_confirm 守卫。
 *
 * @param prevRaw  服务端当前 canvasData 原始串（可能为 null / 脏 JSON）
 * @param next     客户端提交的画布对象（原样返回或字段级修正后的同一对象）
 * @returns 守卫后的画布对象；next 非 canvas 形状时原样返回（保存优先）
 */
export function guardPendingConfirmStatuses(prevRaw: string | null, next: unknown): unknown {
  const nextCanvas = next as GuardCanvas | null
  if (!nextCanvas || !Array.isArray(nextCanvas.nodes)) return next
  let prevNodes: Map<string, { data?: { status?: unknown } }> | undefined
  try {
    const prevCanvas =
      typeof prevRaw === 'string'
        ? (JSON.parse(prevRaw) as { nodes?: Array<{ id?: string; data?: { status?: unknown } }> })
        : null
    if (prevCanvas && Array.isArray(prevCanvas.nodes)) {
      prevNodes = new Map(
        prevCanvas.nodes
          .filter((n) => typeof n?.id === 'string')
          .map((n) => [n.id as string, n]),
      )
    }
  } catch {
    return next // 旧数据脏：守卫直通，保存优先
  }
  if (!prevNodes) return next
  for (const node of nextCanvas.nodes) {
    const prevNode = typeof node?.id === 'string' ? prevNodes.get(node.id) : undefined
    if (prevNode?.data?.status !== 'pending_confirm') continue
    const status = node?.data?.status
    if (typeof status !== 'string' || !PENDING_CONFIRM_CLIENT_EXITS.has(status)) {
      node.data = { ...(node.data ?? {}), status: 'pending_confirm' }
    }
  }
  return next
}
