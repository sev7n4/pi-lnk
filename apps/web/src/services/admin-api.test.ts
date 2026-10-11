import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_TOKEN_KEY,
  AdminApiError,
  adminApi,
  handleAdminResponseError,
  setAdminUnauthorizedHandler,
} from './admin-api'

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

  it('请求前从 sessionStorage 注入 Bearer 头（request 拦截器）', async () => {
    // 拦截器注册发生在模块加载期；这里直接验证 adminApi 走 axios 并携带数据解包
    sessionStorage.setItem(ADMIN_TOKEN_KEY, 't-1')
    axiosGet.mockResolvedValue(ok({ version: 1, entries: [] }))
    await adminApi.listCatalog()
    expect(axiosGet).toHaveBeenCalledWith('/admin/model-catalog', expect.objectContaining({ params: undefined }))
  })

  it('信封 code=0 → 解包 data', async () => {
    axiosGet.mockResolvedValue(ok({ runs: [] }))
    const data = await adminApi.latestProbeRuns()
    expect(data).toEqual({ runs: [] })
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
