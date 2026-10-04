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
 * ⚠️ 必须**大于**服务端 `VIDEO_POLL_TIMEOUT_MS`（`1_260_000`）——
 * 否则服务端刚判超时、客户端已先放弃 ⇒ 用户拿不到最后那次的错误信息。
 * 取服务端 + 60s。
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 1_320_000

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
