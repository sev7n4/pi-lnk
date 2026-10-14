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
}
