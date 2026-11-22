/**
 * 生成确认的审批分级判定（纯函数）—— 规格
 * `docs/superpowers/specs/2026-11-22-generation-auto-approve-gate-design.md` §3.2。
 *
 * 判定权在服务端 SSOT：agent / 客户端**不可传入 tier**（沿袭 P1-D service:1489 纪律）。
 * 三层合取（与规格公式同形）：
 *
 *   auto = mode !== 'full_manual'
 *        && ( mode === 'auto_all'
 *             || tier 白名单含该介质
 *             || ( 用户已授权 && 该介质 ∈ 用户可授权集 ) )
 *
 * 硬门禁（missing_refs / 生成中守卫 / stagedActions / 配额）**不在本函数内**——它们在
 * propose 流程更早的位置 fail-closed，与授权判定正交（规格 §6.4 不变量 2）。
 */

/** 系统级模式（env `GENERATION_APPROVAL_MODE`）。 */
export type GenerationApprovalMode = 'full_manual' | 'tiered' | 'auto_all'

/** 用户级授权偏好（账号级 `UserAiPreferences.autoApproveGenerations`）。 */
export type AutoApprovePref = 'manual' | 'auto'

/** 判定归因（写入日志，保证观测分母不失真）。 */
export type AutoApproveReason =
  | 'system_auto_all'
  | 'tier_whitelist'
  | 'user_auto'
  | 'system_forced_manual'
  | 'user_manual'
  | 'media_not_eligible'
  | 'user_pref_unknown'

/**
 * 用户级授权可覆盖的介质（规格 §8 拍板②）。
 * - `text` 不在其中：文本零成本且现状已默认免确认（tier 白名单），不纳入本开关。
 * - `video` 不在其中：成本放大，仅系统 `auto_all` 放开。
 */
export const USER_AUTO_ELIGIBLE_MEDIA = ['image', 'audio'] as const

/** 解析系统模式；未知值退化为 `tiered`（与缺省行为一致，兼容现状）。 */
export function parseApprovalMode(raw: string | undefined): GenerationApprovalMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'full_manual' || v === 'auto_all' || v === 'tiered') return v
  return 'tiered'
}

/** 解析逗号分隔介质白名单；`''` ⇒ 空表（全人工回滚），`undefined` ⇒ 用缺省 `text`。 */
export function parseMediaWhitelist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 审批分级判定。
 *
 * @param mediaType    节点介质（image / video / audio / text）
 * @param mode         env `GENERATION_APPROVAL_MODE` 原值（缺省 tiered）
 * @param whitelistRaw env `GENERATION_AUTO_APPROVE` 原值（缺省 'text'；'' ⇒ 空表）
 * @param userPref     用户偏好；**undefined = 尚未加载**（调用方分两段取，避免每次 propose 打 DB）
 */
export function resolveAutoApproveTier(input: {
  mediaType: string
  mode?: string | undefined
  whitelistRaw?: string | undefined
  userPref?: AutoApprovePref | undefined
}): { auto: boolean; reason: AutoApproveReason } {
  const mode = parseApprovalMode(input.mode)

  // 系统强制人工（最高优先级，覆盖用户选择）——部署级 kill switch。
  if (mode === 'full_manual') return { auto: false, reason: 'system_forced_manual' }

  // 系统放开全介质（运营决策，成本放大由系统承担）。
  if (mode === 'auto_all') return { auto: true, reason: 'system_auto_all' }

  const whitelist = parseMediaWhitelist(
    input.whitelistRaw === undefined ? 'text' : input.whitelistRaw,
  )
  if (whitelist.includes(input.mediaType)) return { auto: true, reason: 'tier_whitelist' }

  // 用户级授权仅对白名单内介质生效（image + audio）。
  if (!(USER_AUTO_ELIGIBLE_MEDIA as readonly string[]).includes(input.mediaType)) {
    return { auto: false, reason: 'media_not_eligible' }
  }

  if (input.userPref === undefined) return { auto: false, reason: 'user_pref_unknown' }
  if (input.userPref === 'auto') return { auto: true, reason: 'user_auto' }
  return { auto: false, reason: 'user_manual' }
}
