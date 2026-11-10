/**
 * 历史失败分窗判据（2026-11-10）。
 *
 * 生产取证：会话 `cmw56hqit00nck801povzca3e` 的 4 个失败节点在每次
 * `loadSession` 时被 `reconcileMissingGenerationRecords → buildStudioRecordPatch`
 * 从 `failed` 刷成 `error`，构成 `shouldToastForFailure` 的「转移到 error」边
 * ⇒ 每次重开会话必弹 4 条 `ElMessage(warning)` 黄条。
 *
 * 本模块只做「加载期对账要不要降级」的纯判据，不碰渲染、不碰 DB。
 * 返回 null = 不适用（走既有对账逻辑，如 completed 产物回填）。
 */
import { isFailureTerminalStatus } from '@/utils/incompleteNode'

export type NodeFailureScope = 'active' | 'historical' | 'dismissed'

export interface HistoricalFailureNodeData {
  status?: unknown
  failureScope?: unknown
}

export interface HistoricalFailureRecord {
  id?: unknown
  status?: unknown
}

/**
 * 从持久化画布恢复的失败终态节点 ⇒ 静态历史标记，不得重新激活成「本次失败」。
 *
 * 不变式：
 * 1. 不产生 `error` 转移（status 原样保留）；
 * 2. 不写 `errorMessage`（活跃错误条与 toast 都依赖它）；
 * 3. `dismissed` 不被覆盖回 `historical`（用户显式忽略优先）；
 * 4. 不删除节点、不删除记录、不改退费事实。
 */
export function resolveHistoricalFailurePatch(
  nodeData: HistoricalFailureNodeData,
  record: HistoricalFailureRecord,
): Record<string, unknown> | null {
  if (record.status !== 'failed' && record.status !== 'error') return null
  if (!isFailureTerminalStatus(nodeData.status)) return null

  // 用户显式忽略优先：重复加载不得把 dismissed 刷回 historical。
  const scope: NodeFailureScope = nodeData.failureScope === 'dismissed'
    ? 'dismissed'
    : 'historical'

  return {
    // 原样保留失败终态 ⇒ 不产生 failed → error 转移。
    status: nodeData.status,
    failureScope: scope,
    generationRecordId: record.id,
    // 清空活跃错误条文案；失败原因与退费信息仍在记录/诊断抽屉里可查。
    errorMessage: null,
  }
}

/**
 * 用户点「忽略 / 不再提示」（2026-11-10）。
 *
 * 只对「从持久化画布恢复的历史失败」开放：本次真实失败（scope 缺省 / active）
 * 仍由 toast + 错误条承担，不能一键消音让用户误以为生成成功。
 * 返回 null = 不写画布（幂等 / 非法状态），由页面级 provider 直接跳过。
 */
export function resolveDismissFailurePatch(
  nodeData: HistoricalFailureNodeData,
): Record<string, unknown> | null {
  if (nodeData.failureScope !== 'historical') return null
  if (!isFailureTerminalStatus(nodeData.status)) return null
  // 只标记，不删节点、不改 status、不改产物与退费事实。
  return { failureScope: 'dismissed' }
}
