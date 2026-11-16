import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

  // P3-B 菜单快照：三张「原始数据·高级」页下线 + 发布流/灰度藏菜单后，
  // 侧栏菜单项由 12 收敛到 7（模型目录·上游路由·健康探活·定价中心·平台渠道定价·审计日志·使用说明）；
  // 「平台渠道定价」属阶段 C 范围，本刀保留 ⇒ 最终 6 项在 C 完成后达成。
  describe('P3-B 菜单收敛', () => {
    async function mountWithToken() {
      verifyMock.mockResolvedValue({ version: 1, entries: [] })
      const w = mountPage()
      await w.find('input[type="password"]').setValue('sk-admin')
      await w.find('button').trigger('click')
      await flushPromises()
      return w
    }

    it('可见菜单项 = 7，且不含三张高级页与发布流/灰度', async () => {
      const w = await mountWithToken()
      const items = w.findAll('.el-menu-item')
      expect(items.length).toBe(7)
      const text = items.map((i) => i.text()).join('|')
      expect(text).toContain('定价中心')
      expect(text).toContain('平台渠道定价')
      expect(text).toContain('审计日志')
      expect(text).toContain('使用说明')
      // 已下线的三张高级页
      expect(text).not.toContain('主体（高级）')
      expect(text).not.toContain('成本（高级）')
      expect(text).not.toContain('利润（高级）')
      // 藏菜单（保留文件与路由作逃生口）
      expect(text).not.toContain('价目发布流')
      expect(text).not.toContain('灰度发布')
    })

    it('发布流与灰度的菜单行仍留在源码（注释保留，取消注释即恢复）', async () => {
      const src = readFileSync(resolve(__dirname, 'AdminLayoutPage.vue'), 'utf8')
      expect(src).toContain('index="/admin/pricing-versions"')
      expect(src).toContain('index="/admin/gray-release"')
    })
  })
})
