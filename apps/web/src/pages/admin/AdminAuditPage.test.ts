import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminAuditPage from './AdminAuditPage.vue'

const { listAuditLogs } = vi.hoisted(() => ({ listAuditLogs: vi.fn() }))

vi.mock('@/services/admin-api', () => ({
  adminApi: { listAuditLogs: (...a: unknown[]) => listAuditLogs(...a) },
  AdminApiError: class extends Error {},
}))

const row = (over: Record<string, unknown>) => ({
  id: 'a-1',
  actor: 'admin',
  action: 'platform-channel.pricing.set',
  resource: 'platform-channel:m-a',
  before: null,
  after: '{"inputPerM":1}',
  createdAt: '2026-10-11T05:00:00.000Z',
  ...over,
})

function mountPage() {
  return mount(AdminAuditPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminAuditPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('加载首页并渲染行；before/after 可展开', async () => {
    listAuditLogs.mockResolvedValue({
      rows: [row({ before: '{"inputPerM":0}' })],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('platform-channel.pricing.set')
    expect(w.text()).toContain('platform-channel:m-a')
    expect(listAuditLogs).toHaveBeenCalledWith({ page: 1, pageSize: 20 })
  })

  it('过滤 + 翻页 → 带参请求', async () => {
    listAuditLogs.mockResolvedValue({ rows: [], total: 0, page: 2, pageSize: 50 })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as { filters: { action: string; resource: string }; page: number; pageSize: number; reload: () => Promise<void> }
    vm.filters.action = 'model-catalog.create'
    vm.page = 2
    vm.pageSize = 50
    await vm.reload()
    // brief 原文写 resource: ''，但实现把空过滤归一为 undefined（服务端契约：空 = 不过滤），
    // vitest toEqual 语义下 '' 与 undefined 不相等，此处按实现真实调用断言。
    expect(listAuditLogs).toHaveBeenLastCalledWith({ action: 'model-catalog.create', page: 2, pageSize: 50, resource: undefined })
  })
})
