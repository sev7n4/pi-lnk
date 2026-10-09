import { NODE_GENERATION_STATUS, isNodeGenerating } from '@/constants/dockStudio'

const TERMINAL_POLL_STATUSES = new Set<string>([
  NODE_GENERATION_STATUS.completed,
  NODE_GENERATION_STATUS.failed,
  NODE_GENERATION_STATUS.error,
  // fallback_pending is NOT terminal for overwrite-from-error recovery
])

function hasRecordId(value: unknown): value is string | number {
  return value != null && value !== ''
}

/**
 * Whether a generation poll / resolve result should write back to the node.
 * Allows terminal writes when the node already shows error/failed but still
 * tracks the same generationRecordId (status desync recovery).
 */
export function shouldApplyGenerationPoll(opts: {
  nodeStatus: unknown
  nodeRecordId: unknown
  incomingRecordId: string
  incomingStatus: string
}): boolean {
  const { nodeStatus, nodeRecordId, incomingRecordId, incomingStatus } = opts

  // Stale poll for an older task — node already tracks a newer record.
  if (hasRecordId(nodeRecordId) && String(nodeRecordId) !== incomingRecordId) {
    return false
  }

  // User cancelled — ignore late results.
  if (nodeStatus === NODE_GENERATION_STATUS.draft) {
    return false
  }

  // User already cancelled / failed locally — do not revive fallback_pending.
  if (
    incomingStatus === NODE_GENERATION_STATUS.fallback_pending &&
    (nodeStatus === NODE_GENERATION_STATUS.error ||
      nodeStatus === NODE_GENERATION_STATUS.failed)
  ) {
    return false
  }

  // Still in-flight on the node.
  if (isNodeGenerating(nodeStatus) || nodeStatus === 'pending') {
    return true
  }

  // Terminal poll for the same recordId must write even if node already error/failed.
  if (
    TERMINAL_POLL_STATUSES.has(incomingStatus) &&
    hasRecordId(nodeRecordId) &&
    String(nodeRecordId) === incomingRecordId
  ) {
    return true
  }

  return false
}

/**
 * 前端「等节点落定」的墙钟上限。
 *
 * ⚠️ 必须 ≥ 服务端各 provider 的真实最坏生成耗时 + 缓冲，否则服务端还在跑、
 * 客户端已先放弃 ⇒ 用户看到假失败（钱已扣、历史里却是成功）。
 *
 * 服务端各 provider 的真实轮询预算（与前端同步核对过，2026-10-09）：
 *   - MiniMax H3：`DEFAULT_MAX_POLL_MS = 1_200_000`（20min）← 真实最大 deadline
 *   - Apimart / Fal / Fal-H3-Max：`maxPollMs = 600_000`（10min）
 *   - Agnes：循环制 `maxPollAttempts=120`，无固定 deadline（异常态最坏 ≈70min，
 *     超出本墙钟，属服务端 120 次轮询配置本身的问题，不在前端墙钟范围内解决）
 *
 * V6 给「创建」阶段补了退避重试（`withUpstreamRetry`：3 次尝试、退避 1.5s+3s），
 * 创建发生在轮询之前，最坏上界 = `3 × 45s`（每次创建挂满 `UPSTREAM_FETCH_TIMEOUT_MS`）
 * `+ 4.5s`（退避）= `139_500ms`。注意这是上界：V6 真正要救的 429/503 是毫秒级
 * 响应，实际只多 ~4.5s；只有「隧道全死、每次创建都挂满 45s」的病理场景才触达上界。
 *
 * 取值（2026-10-09 重算）：`1_200_000 + 139_500 + 120_500(缓冲) = 1_460_000`。
 * 缓冲覆盖 MiniMax H3 病理态创建重试，并给 Agnes 常规轮询留余量。
 * ⚠️ 改任一项（MiniMax `DEFAULT_MAX_POLL_MS` / `UPSTREAM_FETCH_TIMEOUT_MS` /
 * V6 重试次数）都必须重算本值，且 `generationPollGate.settle.test.ts` 里有断言锁住。
 * 另：reaper 孤儿回收默认 `LNKPI_GENERATION_REAP_MINUTES=30`（1_800_000）仍远大于本值，
 * 墙钟超时判「放弃」不会与 reaper 退款冲突。
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 1_460_000

/**
 * 是否已超过墙钟上限。
 *
 * ⚠️ 2026-10-04 新增。`useNodeGeneration.ts:745` 的 `waitForRunGroupMemberSettled`
 * 是 `for (;;)` **无墙钟**：若 `getGeneration` 持续失败且节点状态始终停在
 * `generating`/`pending`，循环永不退出 ⇒ 单次生成可永久挂住 UI。
 *
 * 语义说明：
 * - `timeoutMs` 传 `undefined`/`0` 以下 ⇒ **不设上限**（显式退出），
 *   避免误杀超长任务与测试。
 * - 边界用 `>=`（恰好到点即视为超时），否则会多转一圈。
 */
export function settleDeadlineExceeded(opts: {
  startedAt: number
  timeoutMs?: number
  now?: number
}): boolean {
  const { startedAt, timeoutMs, now = Date.now() } = opts
  if (timeoutMs === undefined) return false
  if (timeoutMs <= 0) return true
  return now - startedAt >= timeoutMs
}

/**
 * 节点是否已经拿到可用产物（图片 / 视频 / 音频的地址）。
 *
 * ⚠️ 2026-10-08 新增。用于轮询墙钟超时（`onTimeout`）的兜底判定：
 * 墙钟只应打击「真的什么也没拿到」的节点。此前 `onTimeout` 无条件写
 * `status: error`，生产实测把已经 completed、图片可正常访问的节点刷成了
 * `error` +「等待生成结果超时，请重试或刷新查看任务历史」，会诱发用户重复
 * 生成（图片按张扣分 ⇒ 重复扣费）。
 *
 * `text` / `prompt` 节点的产物是 `content` 而非地址，不在本函数判定范围。
 */
export function nodeHasUsableOutput(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (Array.isArray(d.images) && d.images.some((u) => typeof u === 'string' && u)) return true
  if (typeof d.url === 'string' && d.url) return true
  return false
}

const MEDIA_TYPE_LABEL: Record<string, string> = {
  audio: '音频',
  image: '图片',
  video: '视频',
}

/**
 * 记录声称 `completed` 但没有任何可用产物时，返回给用户看的一句话；否则 `null`。
 *
 * ⚠️ 2026-10-04 新增。`applyStudioRecord` 对 `completed` 是**无条件**写
 * `status: completed`，而 `parseRecordUrl` 在音频存 COS / metadata 无 url 时
 * 返回 `''` ⇒ 节点永远停在「生成中」却没有任何产物，也没有错误提示。
 *
 * `text`/`prompt` 没有 url 是正常形态，**不误报**。
 */
export function describeCompletedWithoutOutput(record: {
  type?: string | null
  url?: string | null
  metadata?: string | null
}): string | null {
  const type = String(record.type ?? '')
  const label = MEDIA_TYPE_LABEL[type]
  if (!label) return null

  if (record.url) return null
  if (record.metadata) {
    try {
      const meta = JSON.parse(record.metadata) as { url?: unknown; urls?: unknown }
      const single = typeof meta.url === 'string' ? meta.url : ''
      const many = Array.isArray(meta.urls) ? meta.urls.filter((u) => typeof u === 'string' && u) : []
      if (single || many.length) return null
    } catch {
      // metadata 坏了按「无产物」处理，但要给出提示而不是崩
    }
  }
  return `${label}生成完成但没有产物（缺少音频文件地址），请重试`
}
