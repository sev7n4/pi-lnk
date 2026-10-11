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
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
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
  if (status === 401 || status === 403) {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY)
    unauthorizedHandler?.()
  }
  const message = axiosErr?.response?.data?.message ?? axiosErr?.message ?? '请求失败'
  return Promise.reject(new AdminApiError(message, status))
}

adminHttp.interceptors.response.use((response) => response, handleAdminResponseError)

type Envelope<T> = { code: number; message: string; data: T }

async function unwrap<T>(p: Promise<{ data: Envelope<T> }>): Promise<T> {
  const res = await p
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
  deletedAt: string | null
  createdAt: string
  updatedAt: string
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

export const adminApi = {
  /** token 验真：复用目录 GET（最轻的鉴权读端点）。 */
  verify: (): Promise<{ version: number; entries: AdminCatalogEntry[] }> =>
    unwrap(adminHttp.get('/admin/model-catalog', { params: undefined })),

  listCatalog: (): Promise<{ version: number; entries: AdminCatalogEntry[] }> =>
    unwrap(adminHttp.get('/admin/model-catalog', { params: undefined })),

  createCatalogEntry: (input: CatalogEntryInput) =>
    unwrap<{ version: number; entry: AdminCatalogEntry }>(adminHttp.post('/admin/model-catalog', input)),

  updateCatalogEntry: (id: string, input: Partial<CatalogEntryInput>) =>
    unwrap<{ version: number; entry: AdminCatalogEntry }>(adminHttp.put(`/admin/model-catalog/${id}`, input)),

  deleteCatalogEntry: (id: string) =>
    unwrap<{ version: number; id: string; modelKey: string }>(adminHttp.delete(`/admin/model-catalog/${id}`)),

  listRoutes: (): Promise<{ version: number; routes: AdminRouteRow[] }> =>
    unwrap(adminHttp.get('/admin/upstream-routes')),

  updateRoute: (id: string, input: AdminRouteInput) =>
    unwrap<{ version: number; route: AdminRouteRow }>(adminHttp.put(`/admin/upstream-routes/${id}`, input)),

  modelHealth: (windowHours?: 1 | 6 | 24 | 168) =>
    unwrap<{ generatedAt: string; rows: ModelHealthRow[]; alerts: HealthAlert[] }>(
      adminHttp.get('/admin/model-health', { params: windowHours === undefined ? {} : { windowHours } }),
    ),

  latestProbeRuns: (): Promise<{ runs: ProbeRunRow[] }> => unwrap(adminHttp.get('/admin/upstream-probe/latest')),

  platformChannel: (): Promise<PlatformChannelView> => unwrap(adminHttp.get('/admin/platform-channel')),

  setPlatformModelPricing: (name: string, pricing: Record<string, number> | null) =>
    unwrap<{ entry: ChannelModelEntry; previousPricing: Record<string, number> | null }>(
      adminHttp.put(`/admin/platform-channel/models/${encodeURIComponent(name)}/pricing`, { pricing }),
    ),

  listAuditLogs: (params?: { action?: string; resource?: string; page?: number; pageSize?: number }) =>
    unwrap<AuditLogPage>(adminHttp.get('/admin/audit-logs', { params: params ?? {} })),
}
