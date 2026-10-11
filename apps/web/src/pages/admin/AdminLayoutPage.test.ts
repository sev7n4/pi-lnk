import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminLayoutPage from './AdminLayoutPage.vue'
import { ADMIN_TOKEN_KEY } from '@/services/admin-api'

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }))

vi.mock('@/services/admin-api', () => ({
  ADMIN_TOKEN_KEY: 'lnkpi_admin_token',
  adminApi: { verify: (...args: unknown[]) => verifyMock(...args) },
  setAdminUnauthorizedHandler: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ path: '/admin/models' }),
}))

function mountPage() {
  setActivePinia(createPinia())
  return mount(AdminLayoutPage, { global: { plugins: [ElementPlus, createPinia()] } })
}

describe('AdminLayoutPage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    verifyMock.mockReset()
  })

  it('无 token → 渲染输入门，不渲染侧栏', () => {
    const w = mountPage()
    expect(w.find('.admin-gate').exists()).toBe(true)
    expect(w.find('.admin-shell').exists()).toBe(false)
  })

  it('输入 token 验证成功 → 存 sessionStorage 并渲染侧栏', async () => {
    verifyMock.mockResolvedValue({ version: 1, entries: [] })
    const w = mountPage()
    await w.find('input[type="password"]').setValue('sk-admin')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBe('sk-admin')
    expect(w.find('.admin-shell').exists()).toBe(true)
  })

  it('验证失败（401）→ 清 token、停留输入门并提示', async () => {
    verifyMock.mockRejectedValue(new Error('401'))
    const w = mountPage()
    await w.find('input[type="password"]').setValue('bad')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
    expect(w.find('.admin-gate').exists()).toBe(true)
    expect(w.text()).toContain('token 校验失败')
  })
})
