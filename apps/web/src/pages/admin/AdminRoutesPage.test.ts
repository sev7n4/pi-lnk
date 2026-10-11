// apps/web/src/pages/admin/AdminRoutesPage.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminRoutesPage from './AdminRoutesPage.vue'

const { listRoutes, updateRoute } = vi.hoisted(() => ({
  listRoutes: vi.fn(),
  updateRoute: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    listRoutes: (...a: unknown[]) => listRoutes(...a),
    updateRoute: (...a: unknown[]) => updateRoute(...a),
  },
  AdminApiError: class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

const route = (over: Record<string, unknown>) => ({
  id: 'r-1',
  matchType: 'prefix',
  pattern: 'agnes-',
  capability: '*',
  upstream: 'agnes_hub',
  priority: 100,
  enabled: true,
  fallbackApiKeyEnvName: null,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  ...over,
})

function mountPage() {
  return mount(AdminRoutesPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminRoutesPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('渲染路由行与 routesVersion', async () => {
    listRoutes.mockResolvedValue({ version: 3, routes: [route({})] })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('agnes-')
    expect(w.text()).toContain('agnes_hub')
    expect(w.text()).toContain('3')
  })

  it('切换启停 → PUT { enabled } → 成功后刷新', async () => {
    listRoutes.mockResolvedValue({ version: 3, routes: [route({})] })
    updateRoute.mockResolvedValue({ version: 4, route: route({ enabled: false }) })
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { toggleEnabled: (row: { id: string; enabled: boolean; matchType: string }) => Promise<void> }).toggleEnabled({
      id: 'r-1',
      enabled: true,
      matchType: 'prefix',
    })
    await flushPromises()
    expect(updateRoute).toHaveBeenCalledWith('r-1', { enabled: false })
    expect(listRoutes).toHaveBeenCalledTimes(2)
  })

  it('default 行禁止禁用（服务端 409）→ 透出 message', async () => {
    listRoutes.mockResolvedValue({ version: 3, routes: [route({ matchType: 'default', pattern: null })] })
    const { AdminApiError } = await import('@/services/admin-api')
    updateRoute.mockRejectedValue(new AdminApiError('default 行禁止禁用', 409))
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { toggleEnabled: (row: { id: string; enabled: boolean; matchType: string }) => Promise<void> }).toggleEnabled({
      id: 'r-1',
      enabled: true,
      matchType: 'default',
    })
    await flushPromises()
    expect((w.vm as unknown as { actionError: string }).actionError).toContain('default 行禁止禁用')
  })
})
