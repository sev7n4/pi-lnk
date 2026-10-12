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

  // Follow-up ⑤：先验真后落 token——verify 被调用时 sessionStorage 必须仍为空，
  // 且显式传入候选 token（此前实现先 setToken 再 verify，未验证的 token 会短暂可被其他请求读到）
  it('验证顺序：先 verify（带候选 token 参数）→ 成功后才落 sessionStorage', async () => {
    let sessionStorageAtVerify: string | null = 'unset'
    verifyMock.mockImplementation(async (token: unknown) => {
      sessionStorageAtVerify = sessionStorage.getItem(ADMIN_TOKEN_KEY)
      expect(token).toBe('sk-admin')
      return { version: 1, entries: [] }
    })
    const w = mountPage()
    await w.find('input[type="password"]').setValue('sk-admin')
    await w.find('button').trigger('click')
    await flushPromises()
    expect(sessionStorageAtVerify).toBeNull()
    expect(sessionStorage.getItem(ADMIN_TOKEN_KEY)).toBe('sk-admin')
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
