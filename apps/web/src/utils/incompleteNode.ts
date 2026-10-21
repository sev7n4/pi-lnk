/**
 * 节点「未完成」态的前端判据（批次 3.1 前端）。
 *
 * ## 为什么要有这个状态
 *
 * 后端在「回合被中断且本轮有节点还在跑」时，把那些节点标成
 * `status: 'incomplete'`（见 `apps/server/src/agent/incomplete-node.ts`），
 * 并附两个事实字段：
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `incompleteReason` | 中断类型的人话（`describeTurnInterruption`） |
 * | `incompleteAt` | 中断时刻（epoch ms） |
 *
 * ⭐ `incomplete` **不在** `NODE_GENERATION_STATUS` 枚举里——
 * 与 `pending_confirm` 同理：它不是「生成态」，而是**事实陈述**
 * （「这一轮中断时，这个节点还没跑完」）。
 *
 * ## 关键语义：它不是「生成中」
 *
 * 后端标 `incomplete` 时该节点原本是 `generating`，但**生成任务可能仍在后台跑**
 * （studio 侧的 generation record 与 agent 那一轮是两条独立的生命周期）。
 * ⇒ 前端**不能**把它当 `generating` 处理（那会让 dock 门控、裁剪禁用等逻辑误判），
 * 也**不能**把它当终态（那会让它永远停在「未完成」）。
 *
 * ⇒ 正确口径：`incomplete` 节点**照常参与**生成结果的写回
 * （`shouldApplyGenerationPoll` 的终态写回分支不看 status 白名单，
 * 只要 recordId 相同就允许覆盖）⇒ 生成后来完成了，角标自然消失。
 *
 * ## 为什么不主动清除
 *
 * `incomplete` 是**事实陈述**而不是状态机的一环：生成流程后续写
 * `status: 'completed'` / `'failed'` 时，深合并（`mergeNodeData`）会自然覆盖它；
 * 而流程再也没碰过的节点就该**保留**「未完成」——它确实还没完成。
 * ⇒ 主动清除反而会说谎。
 *
 * 本模块只做**判据 + 文案**，不做渲染；渲染挂在 `NeoBaseNode.vue`（节点公共外壳），
 * 一处覆盖全部 10 种节点类型。
 */

/** 后端写入的「未完成」状态值（与 `incomplete-node.ts` 的常量同源）。 */
export const NODE_INCOMPLETE_STATUS = 'incomplete'

/** 节点是否处于「未完成」态。 */
export function isIncompleteNode(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const status = (data as Record<string, unknown>).status
  return String(status ?? '') === NODE_INCOMPLETE_STATUS
}

/** 中断原因（后端写入的人话）。缺省空串。 */
export function incompleteReasonOf(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const reason = (data as Record<string, unknown>).incompleteReason
  return typeof reason === 'string' ? reason.trim() : ''
}

/**
 * 「未完成」角标上显示的文案。
 *
 * 有原因 ⇒ 「未完成 · <原因>」；没原因 ⇒ 只显示「未完成」。
 * ⛔ 不用省略号截断原因（用户要靠它判断要不要重试）——角标容器自己限宽 + 省略。
 */
export function incompleteBadgeLabel(data: unknown): string {
  const reason = incompleteReasonOf(data)
  return reason ? `未完成 · ${reason}` : '未完成'
}

/**
 * 节点内占位区的文案（`generating` / `uploading` / `incomplete` / 空闲）。
 *
 * ⭐ 抽成共享函数的原因：占位文案散落在 `CanvasNodeImage.vue` / `CanvasNodeVideo.vue`
 * 等多处模板里（内联三元），新增 `incomplete` 档若逐处改极易漏改
 * ⇒ 统一走这里，一个取值点。
 *
 * @param generatingText 各节点自己的「生成中」文案（如视频节点是「视频生成中...」）。
 *
 * ⚠️ 语义顺序要紧：`incomplete` 优先于 `generating`——
 * 后端标 `incomplete` 时节点原本是 `generating`，两者可能同时成立
 * （后台任务还在跑，但那一轮已中断）⇒ 展示层应说「未完成」而不是「生成中」。
 */
export function nodePlaceholderText(status: unknown, generatingText = '生成中...'): string {
  const s = String(status ?? '')
  if (s === NODE_INCOMPLETE_STATUS) return '未完成'
  if (s === 'uploading') return '上传中'
  if (s === 'generating') return generatingText
  return '上传或等待生成'
}
