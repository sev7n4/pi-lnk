import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_TOKEN_KEY,
  adminApi,
  handleAdminRequest,
  handleAdminResponseError,
  setAdminUnauthorizedHandler,
} from './admin-api'
import type { InternalAxiosRequestConfig } from 'axios'

const { axiosGet, axiosPut, axiosPost, axiosDelete } = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  axiosPut: vi.fn(),
  axiosPost: vi.fn(),
  axiosDelete: vi.fn(),
}))

vi.mock('axios', () => {
  const interceptors = {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  }
  const instance = {
    get: (...args: unknown[]) => axiosGet(...args),
    put: (...args: unknown[]) => axiosPut(...args),
    post: (...args: unknown[]) => axiosPost(...args),
    delete: (...args: unknown[]) => axiosDelete(...args),
    interceptors,
  }
  return {
    default: {
      create: vi.fn(() => instance),
      // 拦截器注册后手动触发用
      __instance: instance,
    },
  }
})

vi.mock('./api-base', () => ({ getApiBaseUrl: () => '/api' }))

function ok(data: unknown) {
  return { data: { code: 0, message: 'ok', data } }
}

describe('admin-api', () => {
  beforeEach(() => {
    sessionStorage.clear()
    axiosGet.mockReset()
    axiosPut.mockReset()
  })

  afterEach(() => {
    setAdminUnauthorizedHandler(null)
  })

  it('listCatalog 调用 GET /admin/model-catalog（URL/params 形态）', async () => {
    axiosGet.mockResolvedValue(ok({ version: 1, entries: [] }))
    await adminApi.listCatalog()
    expect(axiosGet).toHaveBeenCalledWith('/admin/model-catalog', expect.objectContaining({ params: undefined }))
  })

  it('updateRoute 携带 X-Confirm 头且值等于路由行 id（服务端 428 防线）', async () => {
    axiosPut.mockResolvedValue(ok({ version: 2, route: { id: 'r1' } }))
    await adminApi.updateRoute('r1', { enabled: false })
    expect(axiosPut).toHaveBeenCalledWith(
      '/admin/upstream-routes/r1',
      { enabled: false },
      expect.objectContaining({ headers: { 'X-Confirm': 'r1' } }),
    )
  })

  it('handleAdminRequest：token 存在 → 注入 Bearer Authorization 头', () => {
    sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
    const config = { headers: {} } as InternalAxiosRequestConfig
    const result = handleAdminRequest(config)
    expect(result.headers.Authorization).toBe('Bearer t-1')
  })

  it('handleAdminRequest：token 缺失 → 不设置 Authorization 头', () => {
    const config = { headers: {} } as InternalAxiosRequestConfig
    const result = handleAdminRequest(config)
    expect(result.headers.Authorization).toBeUndefined()
  })

  it('handleAdminRequest：不影响 config 其余字段', () => {
    sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
    const config = { headers: {}, baseURL: '/api', url: '/admin/model-catalog' } as InternalAxiosRequestConfig
    const result = handleAdminRequest(config)
    expect(result.baseURL).toBe('/api')
    expect(result.url).toBe('/admin/model-catalog')
    expect(result.headers.Authorization).toBe('Bearer t-1')
  })

  it('信封 code=0 → 解包 data', async () => {
    axiosGet.mockResolvedValue(ok({ runs: [] }))
    const data = await adminApi.latestProbeRuns()
    expect(data).toEqual({ runs: [] })
  })

  // Follow-up ⑦：信封 code!==0（HTTP 200 但业务失败）此前被静默当成功解包
  it('信封 code!==0 → 抛 AdminApiError（携带 message），不解包 data', async () => {
    axiosGet.mockResolvedValue({ data: { code: 1, message: '业务失败原因', data: null } })
    await expect(adminApi.latestProbeRuns()).rejects.toMatchObject({
      name: 'AdminApiError',
      message: '业务失败原因',
    })
  })

  // Follow-up ⑤：token 先验真后落库——verify 支持显式 token（不依赖 sessionStorage 拦截器注入）
  it('verify(token) → 显式 Authorization 头覆盖请求', async () => {
    axiosGet.mockResolvedValue(ok({ version: 1, entries: [] }))
    await adminApi.verify('sk-candidate')
    expect(axiosGet).toHaveBeenCalledWith(
      '/admin/model-catalog',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk-candidate' } }),
    )
  })

  it('HTTP 401 → 清 sessionStorage + 触发 handler + 抛 AdminApiError', async () => {
    const onUnauthorized = vi.fn()
    setAdminUnauthorizedHandler(onUnauthorized)
    sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
    await expect(
      handleAdminResponseError({
        response: { status: 401, data: { message: 'Unauthorized' } },
        message: 'Request failed',
      }),
    ).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
  })

  it('HTTP 403 同样清理；其他错误不清 token', async () => {
    const onUnauthorized = vi.fn()
    setAdminUnauthorizedHandler(onUnauthorized)
    sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
    await expect(
      handleAdminResponseError({ response: { status: 403, data: { message: 'Forbidden' } }, message: 'x' }),
    ).rejects.toMatchObject({ status: 403 })
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
    sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
    await expect(
      handleAdminResponseError({ response: { status: 500, data: { message: 'boom' } }, message: 'x' }),
    ).rejects.toMatchObject({ status: 500 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBe('t-1')
  })
})
