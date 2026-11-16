/**
 * M1-3 web 技能控制面 API（对齐 Nest SkillsController 11 端点）。
 *
 * 用用户侧 `api` 实例（localStorage token），但 controller 返回统一信封
 * `{ code, message, data }`，故在层内做一次 unwrap（同 admin-api 口径，只是 token 来源不同）。
 * ⚠️ HTTP 非 2xx 由 axios 直接 reject，调用处需 catch；unwrap 只处理 200 但 code!==0 的业务失败。
 */
import { api } from './api'

export interface SkillEnvelope<T> {
  code: number
  message: string
  data: T
}

export class SkillApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'SkillApiError'
  }
}

/** HTTP 200 但 code!==0 ⇒ 业务失败（fail-closed，不静默当成功）。 */
export async function unwrapSkillEnvelope<T>(
  p: Promise<{ data: SkillEnvelope<T>; status: number }>,
): Promise<T> {
  const res = await p
  if (res.data?.code !== 0) {
    throw new SkillApiError(res.data?.message || '响应信封异常', res.status)
  }
  return res.data.data
}

// ─── 与 Nest controller/service 逐字对齐的类型 ──────────────────────────────────

export interface CatalogItem {
  packageHash: string
  skill: string
  displayName: string
  publisher: string
  version: string
  summary: string
  description: string
  vertical: string
  tags: string[]
  featured: boolean
  usageCount: number
  installCount: number
  compatProfile: string
  compatScore: number
  license: string
}

export interface MineItem {
  id: string
  packageHash: string
  sourceType: string
  trustLevel: string
  enabled: boolean
  pinnedHash: string
  installedAt: string
  skill: string
  displayName: string
  publisher: string
  version: string
  compatProfile: string
  disableModelInvocation: boolean
  userInvocable: boolean
}

export interface SkillDetail extends MineItem {
  scanReport: Record<string, unknown>
  compatScore: number
  license: string | null
  userModified: boolean
  uninstalledAt: string | null
}

export interface CatalogParams {
  q?: string
  vertical?: string
  tag?: string
  sort?: 'comprehensive' | 'usage' | 'installs' | 'updated'
  limit?: string
}

/** 运行时内置技能（与 pi-runtime GET /skills / Nest GET /skills/runtime data 逐字对齐）。 */
export interface RuntimeSkill {
  name: string
  description: string
}

export const skillApi = {
  /** GET /skills/catalog —— 唯一无 AuthGuard 的读端点。 */
  catalog: (params?: CatalogParams) =>
    unwrapSkillEnvelope<CatalogItem[]>(api.get('/skills/catalog', { params })),

  /** GET /skills/mine —— 当前用户已装技能（含 enabled / pinnedHash）。 */
  mine: () => unwrapSkillEnvelope<MineItem[]>(api.get('/skills/mine')),

  /** GET /skills/runtime —— 运行时内置技能清单（薄转发 pi-runtime /skills；失败 → SkillApiError，调用处 fail-soft）。 */
  runtimeList: () =>
    unwrapSkillEnvelope<{ skills: RuntimeSkill[] }>(api.get('/skills/runtime')).then((d) => d.skills),

  /** GET /skills/search?q= —— 平台精选内搜索。 */
  search: (q: string) =>
    unwrapSkillEnvelope<unknown[]>(api.get('/skills/search', { params: { q } })),

  /** GET /skills/:id —— 详情（兼容评分 + 不可用动作清单）。 */
  detail: (id: string) =>
    unwrapSkillEnvelope<SkillDetail>(api.get(`/skills/${encodeURIComponent(id)}`)),

  /** POST /skills/import —— 自定义加载（paste/zip/url/github）。 */
  import: (text: string, sourceType = 'paste') =>
    unwrapSkillEnvelope<{ id: string; packageHash: string; skill: string; enabled: boolean }>(
      api.post('/skills/import', { text, sourceType }),
    ),

  /** POST /skills/:packageHash/install —— 一键安装（新装默认 enabled=false）。 */
  install: (packageHash: string) =>
    unwrapSkillEnvelope<{ packageHash: string; enabled: boolean } | { id: string; alreadyInstalled: boolean }>(
      api.post(`/skills/${encodeURIComponent(packageHash)}/install`),
    ),

  /** PATCH /skills/:id/enabled —— 启停（下一轮新会话生效）。 */
  setEnabled: (id: string, enabled: boolean) =>
    unwrapSkillEnvelope<{ id: string; enabled: boolean }>(
      api.patch(`/skills/${encodeURIComponent(id)}/enabled`, { enabled }),
    ),

  /** POST /skills/uninstall —— 批量卸载（confirmed=true 强制）。 */
  uninstallBatch: (ids: string[], confirmed = true) =>
    unwrapSkillEnvelope<{ uninstalled: number }>(
      api.post('/skills/uninstall', { ids, confirmed }),
    ),

  /** DELETE /skills/:id?confirmed=true —— 单删（confirmed 走 query 字符串）。 */
  remove: (id: string) =>
    unwrapSkillEnvelope<{ uninstalled: number }>(
      api.delete(`/skills/${encodeURIComponent(id)}`, { params: { confirmed: 'true' } }),
    ),

  /** POST /skills/:id/rollback —— 回滚到上一版本。 */
  rollback: (id: string) =>
    unwrapSkillEnvelope<{ id: string; pinnedHash: string }>(
      api.post(`/skills/${encodeURIComponent(id)}/rollback`),
    ),

  /** POST /skills/:id/invoke —— 显式调用裁决（denied → 403）。 */
  invoke: (id: string, intent: 'implicit' | 'explicit' | 'routed' = 'explicit') =>
    unwrapSkillEnvelope<{ mode: string; skill: string; packageHash: string }>(
      api.post(`/skills/${encodeURIComponent(id)}/invoke`, { intent }),
    ),
}
