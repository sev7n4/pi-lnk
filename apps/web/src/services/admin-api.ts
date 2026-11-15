import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios'
import { getApiBaseUrl } from './api-base'
import type { HealthAlert, ModelHealthRow } from '@lnkpi/shared/modelHealth'

/**
 * Ops Console admin API（spec §4.2）：
 * - 独立 axios 实例：Bearer 来自 sessionStorage（不落 localStorage、不进 URL、不打日志）。
 * - 401/403 → 清 token + 回调 store（回输入门）；其余错误归一为 AdminApiError。
 * - 服务端信封 { code, message, data }；HTTP 错误体为 Nest 异常 { message, statusCode }。
 */

export const ADMIN_TOKEN_KEY = 'lnkpi_admin_token'

export class AdminApiError extends Error {
  readonly status: number
  /** HTTP 响应体原文（409 时含 `alternatives` 等拓展字段），供调用方读取结构化判据。 */
  readonly payload?: unknown
  constructor(message: string, status: number, payload?: unknown) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
    this.payload = payload
  }
}

export const adminHttp: AxiosInstance = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 30_000,
})

/** 请求拦截器纯函数（可导出以便测试直调）：token 存在时注入 Bearer 头。 */
export function handleAdminRequest(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY)
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
}

adminHttp.interceptors.request.use(handleAdminRequest)

type UnauthorizedHandler = () => void
let unauthorizedHandler: UnauthorizedHandler | null = null

export function setAdminUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler
}

/** 响应错误归一（可导出以便测试直调）：401/403 清会话，其余原样归一。 */
export function handleAdminResponseError(err: unknown): Promise<never> {
  const axiosErr = err as AxiosError<{ message?: string }> | undefined
  const status = axiosErr?.response?.status ?? 0
  const payload = axiosErr?.response?.data
  if (status === 401 || status === 403) {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY)
    unauthorizedHandler?.()
  }
  const message =
    (payload && typeof payload === 'object' && 'message' in payload
      ? (payload as { message?: unknown }).message
      : undefined) ?? axiosErr?.message ?? '请求失败'
  return Promise.reject(new AdminApiError(typeof message === 'string' ? message : '请求失败', status, payload))
}

adminHttp.interceptors.response.use((response) => response, handleAdminResponseError)

type Envelope<T> = { code: number; message: string; data: T }

async function unwrap<T>(p: Promise<{ data: Envelope<T>; status: number }>): Promise<T> {
  const res = await p
  // Follow-up ⑦：HTTP 200 但信封 code!==0 = 业务失败，归一为 AdminApiError（此前被静默当成功解包）
  if (res.data?.code !== 0) {
    throw new AdminApiError(res.data?.message || '响应信封异常', res.status)
  }
  return res.data.data
}

// ---- 服务端契约类型（与 apps/server/src/admin/*.controller.ts 对齐）----

export type AdminCatalogEntry = {
  id: string
  modelKey: string
  displayName: string
  gatewayModelId: string
  modality: string
  providerBinding: string
  audioKind: string | null
  voices: { id: string; label: string }[] | null
  params: Record<string, unknown>
  defaults: Record<string, unknown> | null
  /** 每模态默认标记（DB isDefault 透传）；前端据此展示「默认」徽标 + 下架防呆判据。 */
  isDefault?: boolean
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

/** 切默认时的在架候选（服务端 409 体附带，与 server model-ops-shared DefaultAlternative 一致）。 */
export type CatalogDefaultAlternative = {
  modelKey: string
  displayName: string
  availability: 'available' | 'unavailable' | 'unknown'
}

/**
 * 目录条目链路原料（2026-10-12 目录页【上游端点 + 链路状态】增强），以 modelKey 为键。
 * 服务端组装失败时 fail-soft 下发 null ⇒ 可选字段，前端对缺省渲染「—」。
 */
export type AdminCatalogLinkOps = {
  upstream: string | null
  baseUrl: string | null
  availability: 'available' | 'unavailable' | 'unknown' | null
  completed24h: number
  balance40224h: number
}

export type CatalogEntryInput = {
  modelKey?: string
  displayName?: string
  gatewayModelId?: string
  modality?: string
  providerBinding?: string
  audioKind?: string | null
  voices?: { id: string; label: string }[] | null
  params?: Record<string, unknown>
  defaults?: Record<string, unknown> | null
}

export type AdminRouteRow = {
  id: string
  matchType: string
  pattern: string | null
  capability: string
  upstream: string
  priority: number
  enabled: boolean
  fallbackApiKeyEnvName: string | null
  createdAt: string
  updatedAt: string
}

export type AdminRouteInput = Partial<Pick<AdminRouteRow, 'matchType' | 'pattern' | 'capability' | 'upstream' | 'priority' | 'enabled' | 'fallbackApiKeyEnvName'>>

export type ProbeRunRow = {
  id: string
  ranAt: string
  upstream: string
  httpStatus: number | null
  modelCount: number
  ghosts: string[]
  missing: string[]
  error: string | null
  reason: string | null
}

export type ChannelModelEntry = { name: string; capability: string; pricing?: Record<string, number> } & Record<string, unknown>

export type PlatformChannelView = {
  id: string
  name: string
  apiFormat: string
  models: ChannelModelEntry[]
  parseError: boolean
}

export type AuditLogRow = {
  id: string
  actor: string
  action: string
  resource: string
  before: string | null
  after: string | null
  createdAt: string
}

export type AuditLogPage = { rows: AuditLogRow[]; total: number; page: number; pageSize: number }

// ---- P1-a T8：价目发布流 + 灰度发布（与 pricing-publishing/pricing-gray controller 对齐）----

export type AdminPriceListVersion = {
  id: string
  version: string
  status: string
  note: string | null
  entryCount: number
  publishedAt: string | null
  createdAt: string
}

export type AdminPublishEntry = {
  matchKey: string
  capability: string
  credits: number
  basis?: string
  costRateId?: string | null
}

export type AdminDraftView = {
  id: string
  version: string
  status: string
  note: string | null
  entries: AdminPublishEntry[]
}

/**
 * 与 PricingPublishingService.DiffSummary 对齐；floorViolations/missingCost/noCostCoverage 前端需标红/标注。
 * 无 removed 字段：服务端 upsertEntries 不提供删条目能力，removed 恒 0（死计数已删）。
 */
export type AdminDiffSummary = {
  draftVersion: string
  activeVersion: string | null
  added: number
  changed: number
  unchanged: number
  maxIncrease: { matchKey: string; from: number; to: number; pct: number } | null
  maxDecrease: { matchKey: string; from: number; to: number; pct: number } | null
  /** 发布确认弹窗公告预告（2026-11-15 公告设计 §6）：涨价/降价/新增档数 */
  increaseCount: number
  decreaseCount: number
  newCount: number
  /** kind='min'：价格行跌破下限（limit=floor）；kind='max'：token 反比率行超过上限（limit=ceiling）。 */
  floorViolations: { matchKey: string; credits: number; limit: number; kind: 'min' | 'max' }[]
  missingCost: string[]
  noCostCoverage: string[]
}

export type AdminGrayRelease = {
  id: string
  status: string
  version: string
  hits: number
  startsAt: string
  endsAt: string
  note: string | null
}

export type AdminGrayPreview = {
  hits: { userId: string; phone: string }[]
  misses: string[]
}

/** txAmountByCategory 含 refund 行金额（前端直接展示，不扣回） */
export type AdminGrayReport = {
  releaseId: string
  version: string
  status: string
  hits: number
  txCount: number
  txAmountByCategory: Record<string, number>
  refundCount: number
  byUser: Array<{ userId: string; consumeCount: number; consumeTotal: number }>
}

export type AdminGrayCreateInput = {
  versionId: string
  /** 粘贴文本（任意分隔符），服务端切分/去重 */
  rawInput?: string
  /** 或直接给号码数组（二选一） */
  phones?: string[]
  startsAt?: string
  endsAt?: string
  note?: string
}

/** automation job 摘要（GET /admin/automations 返回的运营侧子集；C5 P0 只读+trigger）。 */
export type AutomationJobSummary = {
  id: string
  name: string
  handlerKey: string
  enabled: boolean
  lastRun: {
    id: string
    reason: string
    status: string
    startedAt: string
    finishedAt: string | null
    error: string | null
  } | null
}

// ---- S1 定价利润引擎运维端点（与 pricing-cost/margin/subject/materialize controller 对齐）----

/** 成本行录入（单一人民币 D9：无 currency/fxRate 等字段）。 */
export type CostRateInput = {
  channel: string
  modelKey: string
  spec: string
  unit: 'per_image' | 'per_video' | 'per_call' | 'per_1m_tokens' | 'per_second'
  costYuan: number
  unitQuantity?: number
  source?: 'official_list' | 'negotiated' | 'channel_actual' | 'provisional'
  provider?: string | null
  upstream?: string | null
  sourceRef?: string | null
  provisional?: boolean
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

export type CostRateRow = {
  id: string
  channel: string
  modelKey: string
  spec: string
  unit: string
  costYuan: number
  source: string
  provider: string | null
  upstream: string | null
  unitQuantity: number
  effectiveFrom: string | null
  effectiveTo: string | null
  sourceRef: string | null
  provisional: boolean
  createdAt: string
}

/** 极简导入：运维只填 模型 + 档位 + 人民币金额，unit/unitQuantity 由服务端按主体推断。 */
export type CostRateImportRow = {
  modelKey: string
  spec: string
  costYuan: number
  provisional?: boolean
  source?: 'official_list' | 'negotiated' | 'channel_actual' | 'provisional'
}

export type CostRateImportResult = {
  imported: number
  failed: number
  results: Array<{ modelKey: string; spec: string; ok: boolean; message?: string }>
}

/** 定价中心成本记录档位（spec: docs/design/2026-11-15-pricing-console-redesign.md §4）。 */
export type CostRecordTier = {
  spec: string
  label: string
  unit: string
  unitQuantity: number
  costYuan: number | null
  perVideoDerived: number | null
  /**
   * 物化后扣费积分（P1.6）：active 价目表主体行 credits（文本=反比率行，实际结算口径）。
   * video=null（按秒无单一值，见 creditsByDuration）；无物化条目为 null。
   */
  materializedCredits: number | null
  /** 仅视频档：按时长枚举的主体行积分（4s/5s/10s/15s）。 */
  creditsByDuration: { duration: number; credits: number }[] | null
}

export type CostRecordRow = {
  modelKey: string
  displayName: string
  modality: string
  audioKind: string | null
  channel: string
  profitPct: number | null
  tiers: CostRecordTier[]
  subjectsTotal: number
  missingSpecs: string[]
  status: 'ready' | 'partial' | 'missing'
  /** 物化积分取数来源版本（active 优先，无 active 取最新 draft）。 */
  materializedVersion: string | null
}

export type CostRecordUpdateInput = {
  tiers: { spec: string; costYuan: number }[]
  profitPct?: number
}

/** 成本自动采集（spec: docs/design/2026-11-15-cost-auto-collect-design.md §2/D4）。 */
export type CollectCandidateDto = {
  modelKey: string
  spec: string
  rowSpec: string
  unit: string
  unitQuantity: number
  costYuan: number
  source: 'official_list'
  evidence: { url: string; note: string }
}

export type CollectSkipDto = { modelKey: string; spec: string; reason: string }

export type CollectRunReport = {
  ranAt: string
  dryRun: boolean
  adapters: { upstream: string; status: 'ok' | 'error'; candidates: CollectCandidateDto[]; skips: CollectSkipDto[]; error?: string }[]
  uncovered: { upstream: string; modelKeys: string[] }[]
  written: number
  keptManual: { modelKey: string; rowSpec: string }[]
}

/** 利润策略录入：phase 由服务端 phaseOf(scope, scopeKey) 生成。 */
export type MarginPolicyInput = {  scope: string
  scopeKey?: string | null
  profitBp: number
  priceFloorBp?: number
  status?: 'active' | 'draft' | 'disabled'
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

export type MarginPolicyRow = {
  id: string
  scope: string | null
  scopeKey: string | null
  profitBp: number
  priceFloorBp: number
  status: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
}

export type PricingSubjectRow = {
  id: string
  subjectKey: string
  capability: string
  modelKey: string
  spec: string
  provider: string
  upstream: string
  channelId: string
  status: string
  billableUnit: string
  unitsPerRequest: number | null
  defaultSubjectKey: string | null
  source: string
  createdAt: string
  updatedAt: string
}

export type SubjectRebuildResult = {
  added: number
  unchanged: number
  missingInCatalog: string[]
}

export type MaterializeFloorViolation = {
  matchKey: string
  credits: number
  limit: number
  kind: 'min' | 'max'
}

export type MaterializeResult = {
  added: number
  changed: number
  unchanged: number
  missingCost: string[]
  unitMismatch: string[]
  floorViolations: MaterializeFloorViolation[]
  noCostCoverage: string[]
}

export type VersionReadiness = {
  ok: boolean
  violations: string[]
}

export const adminApi = {
  /**
   * token 验真：复用目录 GET（最轻的鉴权读端点）。
   * Follow-up ⑤：支持显式传入候选 token（先验真后落库——不依赖 sessionStorage 拦截器注入）。
   */
  verify: (token?: string): Promise<{ version: number; entries: AdminCatalogEntry[] }> =>
    unwrap(
      adminHttp.get('/admin/model-catalog', {
        params: undefined,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }),
    ),

  listCatalog: (): Promise<{ version: number; entries: AdminCatalogEntry[]; ops?: Record<string, AdminCatalogLinkOps> }> =>
    unwrap(adminHttp.get('/admin/model-catalog', { params: undefined })),

  createCatalogEntry: (input: CatalogEntryInput) =>
    unwrap<{ version: number; entry: AdminCatalogEntry }>(adminHttp.post('/admin/model-catalog', input)),

  updateCatalogEntry: (id: string, input: Partial<CatalogEntryInput>) =>
    unwrap<{ version: number; entry: AdminCatalogEntry }>(adminHttp.put(`/admin/model-catalog/${id}`, input)),

  deleteCatalogEntry: (id: string) =>
    unwrap<{ version: number; id: string; modelKey: string }>(adminHttp.delete(`/admin/model-catalog/${id}`)),

  /**
   * 切默认模型（spec P0-4）：PUT /admin/model-defaults `{modality, modelKey}` + X-Confirm=<modelKey>。
   * 返回新默认态；目标 unavailable / 并发冲突 → 409（体含 message，无 alternatives）。
   */
  setDefault: (
    modality: string,
    modelKey: string,
  ): Promise<{
    version: number
    modality: string
    previousDefault: string | null
    default: { modelKey: string; displayName: string; isDefault: boolean }
  }> =>
    unwrap(
      adminHttp.put('/admin/model-defaults', { modality, modelKey }, { headers: { 'X-Confirm': modelKey } }),
    ),

  listRoutes: (): Promise<{ version: number; routes: AdminRouteRow[] }> =>
    unwrap(adminHttp.get('/admin/upstream-routes')),

  // model-ops Task 2 起服务端要求高危写确认：X-Confirm 头必须等于目标路由行 id（缺失 → 428）
  updateRoute: (id: string, input: AdminRouteInput) =>
    unwrap<{ version: number; route: AdminRouteRow }>(
      adminHttp.put(`/admin/upstream-routes/${id}`, input, { headers: { 'X-Confirm': id } }),
    ),

  modelHealth: (windowHours?: 1 | 6 | 24 | 168) =>
    unwrap<{ generatedAt: string; rows: ModelHealthRow[]; alerts: HealthAlert[] }>(
      adminHttp.get('/admin/model-health', { params: windowHours === undefined ? {} : { windowHours } }),
    ),

  latestProbeRuns: (): Promise<{ runs: ProbeRunRow[] }> => unwrap(adminHttp.get('/admin/upstream-probe/latest')),

  listAutomations: (): Promise<{ jobs: AutomationJobSummary[] }> =>
    unwrap(adminHttp.get('/admin/automations', { params: undefined })),

  /** 手动触发 automation job（C5 trigger 端点）；探活 = handlerKey 'upstream-probe'。 */
  triggerAutomation: (id: string) =>
    unwrap<Record<string, unknown>>(
      adminHttp.post(`/admin/automations/${encodeURIComponent(id)}/trigger`, {}),
    ),

  platformChannel: (): Promise<PlatformChannelView> => unwrap(adminHttp.get('/admin/platform-channel')),

  setPlatformModelPricing: (name: string, pricing: Record<string, number> | null) =>
    unwrap<{ entry: ChannelModelEntry; previousPricing: Record<string, number> | null }>(
      adminHttp.put(`/admin/platform-channel/models/${encodeURIComponent(name)}/pricing`, { pricing }),
    ),

  listAuditLogs: (params?: { action?: string; resource?: string; page?: number; pageSize?: number }) =>
    unwrap<AuditLogPage>(adminHttp.get('/admin/audit-logs', { params: params ?? {} })),

  // ---- P1-a T8：价目发布流（/admin/pricing/versions，全部挂 AdminTokenGuard）----
  pricingVersions: {
    list: (): Promise<AdminPriceListVersion[]> => unwrap(adminHttp.get('/admin/pricing/versions')),

    createDraft: (version: string, note: string): Promise<{ id: string; version: string; entries: number }> =>
      unwrap(adminHttp.post('/admin/pricing/versions/draft', { version, note })),

    get: (id: string): Promise<AdminDraftView> =>
      unwrap(adminHttp.get(`/admin/pricing/versions/${encodeURIComponent(id)}`)),

    putEntries: (id: string, entries: AdminPublishEntry[]): Promise<{ written: number }> =>
      unwrap(adminHttp.put(`/admin/pricing/versions/${encodeURIComponent(id)}/entries`, { entries })),

    diff: (id: string): Promise<AdminDiffSummary> =>
      unwrap(adminHttp.get(`/admin/pricing/versions/${encodeURIComponent(id)}/diff`)),

    publish: (id: string, notifyUsers?: boolean): Promise<{ version: string; announcementId: string | null }> =>
      unwrap(
        adminHttp.post(`/admin/pricing/versions/${encodeURIComponent(id)}/publish`, {
          // notifyUsers 胶囊开关（2026-11-15 用户拍板默认 false）：显式传值才透传，undefined 不发键
          ...(notifyUsers === undefined ? {} : { notifyUsers }),
        }),
      ),

    rollback: (): Promise<{ version: string }> =>
      unwrap(adminHttp.post('/admin/pricing/versions/rollback')),
  },

  // ---- P1-a T8：白名单灰度发布（/admin/pricing/gray）----
  pricingGray: {
    preview: (rawInput: string): Promise<AdminGrayPreview> =>
      unwrap(adminHttp.post('/admin/pricing/gray/preview', { rawInput })),

    create: (input: AdminGrayCreateInput): Promise<{ releaseId: string; version: string; hits: number; window: { startsAt: string; endsAt: string } }> =>
      unwrap(adminHttp.post('/admin/pricing/gray', input)),

    list: (): Promise<AdminGrayRelease[]> => unwrap(adminHttp.get('/admin/pricing/gray')),

    report: (id: string): Promise<AdminGrayReport> =>
      unwrap(adminHttp.get(`/admin/pricing/gray/${encodeURIComponent(id)}/report`)),

    promote: (id: string): Promise<{ version: string }> =>
      unwrap(adminHttp.post(`/admin/pricing/gray/${encodeURIComponent(id)}/promote`)),

    rollback: (id: string): Promise<void> =>
      unwrap(adminHttp.post(`/admin/pricing/gray/${encodeURIComponent(id)}/rollback`)),
  },

  // ---- S1：定价利润引擎运维（成本 / 利润 / 主体 / 物化 / 就绪）----
  pricingS1: {
    listSubjects: (): Promise<PricingSubjectRow[]> => unwrap(adminHttp.get('/admin/pricing/subjects')),

    rebuildSubjects: (): Promise<SubjectRebuildResult> =>
      unwrap(adminHttp.post('/admin/pricing/subjects/rebuild', {})),

    putCostRate: (input: CostRateInput): Promise<{ channel: string; modelKey: string; spec: string }> =>
      unwrap(adminHttp.put('/admin/pricing/cost-rates', input)),

    listCostRates: (): Promise<CostRateRow[]> => unwrap(adminHttp.get('/admin/pricing/cost-rates')),

    /** 极简导入成本：仅传 模型/档位/金额，服务端按主体推断 unit。 */
    importCostRates: (rows: CostRateImportRow[]): Promise<CostRateImportResult> =>
      unwrap(adminHttp.post('/admin/pricing/cost-rates/import', { rows })),

    putMarginPolicy: (input: MarginPolicyInput): Promise<{ phase: string }> =>
      unwrap(adminHttp.put('/admin/pricing/margin-policies', input)),

    /** 定价中心：聚合每个在售模型为一条成本记录（档位/利润率/就绪）。 */
    listCostRecords: (): Promise<CostRecordRow[]> => unwrap(adminHttp.get('/admin/pricing/cost-records')),

    /** 定价中心：更新一条成本记录的档位数值与利润率（只接受在售模型）。 */
    updateCostRecord: (modelKey: string, input: CostRecordUpdateInput): Promise<{ modelKey: string; savedTiers: number; profitBp: number | null }> =>
      unwrap(adminHttp.put(`/admin/pricing/cost-records/${encodeURIComponent(modelKey)}`, input)),

    /** D-2 一次性迁移（幂等）：per_video → per_second，非线性跳过不猜。 */
    migrateVideoPerSecond: (): Promise<{ converted: number; retired: number; skipped: { modelKey: string; res: string; reason: string }[] }> =>
      unwrap(adminHttp.post('/admin/pricing/cost-records/migrate-video-per-second', {})),

    /** 成本自动采集：dryRun=true（缺省）只回预览，确认后 dryRun=false 落库（只写 official_list，不覆盖 manual）。 */
    collectCostRates: (opts: { dryRun?: boolean; upstreams?: string[] }): Promise<CollectRunReport> =>
      unwrap(adminHttp.post('/admin/pricing/cost-collect/run', { dryRun: opts.dryRun ?? true, ...(opts.upstreams ? { upstreams: opts.upstreams } : {}) })),

    listMarginPolicies: (): Promise<MarginPolicyRow[]> => unwrap(adminHttp.get('/admin/pricing/margin-policies')),

    /** 以主体为遍历真源，拉成本 + 利润后物化落草案价目表。 */
    materializeDraft: (id: string): Promise<MaterializeResult> =>
      unwrap(adminHttp.post(`/admin/pricing/versions/${encodeURIComponent(id)}/materialize`)),

    /** 发布门禁七条硬拒预览（validatePublish 结构化 verdict）。 */
    getReadiness: (id: string): Promise<VersionReadiness> =>
      unwrap(adminHttp.get(`/admin/pricing/versions/${encodeURIComponent(id)}/readiness`)),
  },
}
