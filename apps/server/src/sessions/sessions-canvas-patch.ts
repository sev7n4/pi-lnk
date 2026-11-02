/**
 * P1-C C1a：客户端 canvas ops 白名单（规格 2026-11-02-p1c-write-path-governance-design §3.1）。
 *
 * PATCH /sessions/:id/canvas 载荷 `{ ops: CanvasAction[] }`——ops 级复用
 * `@lnkpi/agent` 的 5 类 op（add_node/update_node/remove_node/add_edge/remove_edge），
 * 不发明新方言。本模块只做「客户端可提交什么」的收敛：
 *
 * - **服务端字段禁写**：`update_node.data` 中 status / generationRecordId /
 *   generationStartedAt / errorMessage / proposalEpoch 五键直接剥除并 console.warn
 *   （patch 语义下客户端根本不该提交它们——总纲 §2 不变量 3 的落地形态；
 *    proposalEpoch 属 B6，撤回重提纪元只能由 Nest Phase 2b 推进）。
 * - **未知 op 类型**：剥除并 warn（防 op 方言从客户端侧渗入）。
 * - `remove_node` 对 generating/pending_confirm 节点的 409 拒绝不在本纯函数
 *   （需要 prev canvas 状态），在 SessionsService.patchCanvas。
 *
 * agent/生成链路不受影响：它们走 agent-canvas-tools.persist，不经过本白名单。
 */
import type { CanvasAction } from '@lnkpi/shared'

/** 客户端不得写、只能由服务端链路推进的节点数据键。 */
export const CLIENT_FORBIDDEN_NODE_DATA_KEYS: ReadonlySet<string> = new Set([
  'status',
  'generationRecordId',
  'generationStartedAt',
  'errorMessage',
  'proposalEpoch',
])

/** plain object 判定（侧车 op 载荷校验用；null/数组/标量均非）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 客户端 PATCH 允许的 op 类型（与 applier 对齐：5 类画布 op + set_viewport + C2a 侧车 2 类）。 */
const CLIENT_ALLOWED_OP_TYPES: ReadonlySet<string> = new Set([
  'add_node',
  'update_node',
  'remove_node',
  'add_edge',
  'remove_edge',
  'set_viewport',
  // P1-C C2a：侧车 op（groups / compositionRunGroup）。全量替换语义，
  // 载荷形状由 CanvasActionSchema（@lnkpi/shared SSOT）在 applier 侧约束。
  'set_groups',
  'set_composition_run_group',
])

export interface SanitizeClientOpsResult {
  /** 白名单收敛后可安全落地的 ops。 */
  sanitized: CanvasAction[]
  /** 被剥除的禁写键次数（观测面，测试断言用）。 */
  strippedKeys: number
  /** 被整体剥除的非法 op 数（观测面）。 */
  droppedOps: number
}

/**
 * 对客户端提交的 ops 做白名单收敛（纯函数，不碰 IO）。
 * 输入不可信：非数组返回空结果；op 非 plain object 剥除。
 */
export function sanitizeClientOps(raw: unknown): SanitizeClientOpsResult {
  const out: CanvasAction[] = []
  let strippedKeys = 0
  let droppedOps = 0
  if (!Array.isArray(raw)) return { sanitized: out, strippedKeys, droppedOps }
  for (const op of raw) {
    if (!op || typeof op !== 'object' || typeof (op as { type?: unknown }).type !== 'string') {
      droppedOps += 1
      continue
    }
    const type = (op as { type: string }).type
    if (!CLIENT_ALLOWED_OP_TYPES.has(type)) {
      console.warn(`[canvas_patch] dropped non-whitelisted op type=${type}`)
      droppedOps += 1
      continue
    }
    if (type === 'update_node') {
      const payload = (op as { payload?: Record<string, unknown> }).payload
      const data = payload?.data
      if (data && typeof data === 'object') {
        const cleaned: Record<string, unknown> = { ...(data as Record<string, unknown>) }
        for (const key of CLIENT_FORBIDDEN_NODE_DATA_KEYS) {
          if (key in cleaned) {
            delete cleaned[key]
            strippedKeys += 1
          }
        }
        if (strippedKeys > 0) {
          console.warn(
            `[canvas_patch] stripped server-owned keys from update_node (count=${strippedKeys})`,
          )
        }
        out.push({
          ...(op as CanvasAction),
          payload: { ...(payload ?? {}), data: cleaned },
        } as CanvasAction)
        continue
      }
    }
    // P1-C C2a：侧车 op 全量替换语义，形状不对整体剥除（防脏载荷直接覆盖侧车）。
    if (type === 'set_groups' || type === 'set_composition_run_group') {
      const payload = (op as { payload?: Record<string, unknown> }).payload
      const valid =
        type === 'set_groups'
          ? !!payload && Array.isArray(payload.groups)
          : !!payload &&
            (payload.compositionRunGroup === null ||
              (isPlainObject(payload.compositionRunGroup) &&
                Array.isArray((payload.compositionRunGroup as { nodeIds?: unknown }).nodeIds) &&
                typeof (payload.compositionRunGroup as { dumpHash?: unknown }).dumpHash ===
                  'string' &&
                typeof (payload.compositionRunGroup as { createdAt?: unknown }).createdAt ===
                  'string'))
      if (!valid) {
        console.warn(`[canvas_patch] dropped malformed sidecar op type=${type}`)
        droppedOps += 1
        continue
      }
    }
    out.push(op as CanvasAction)
  }
  return { sanitized: out, strippedKeys, droppedOps }
}
