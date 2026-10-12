import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import AdminGuidePage from './AdminGuidePage.vue'

vi.mock('@/services/admin-api', () => ({
  adminApi: {},
  AdminApiError: class extends Error {},
}))

function mountPage() {
  return mount(AdminGuidePage, { global: { plugins: [ElementPlus] } })
}

describe('AdminGuidePage', () => {
  it('渲染六大板块标题', () => {
    const w = mountPage()
    for (const h of ['登录与 Token', '模型目录', '上游路由', '健康探活', '渠道定价', '审计日志', '常见 SOP']) {
      expect(w.text()).toContain(h)
    }
  })

  it('覆盖关键操作语义（params 处置 / ghost-missing / 定价单位 / 软删恢复）', () => {
    const w = mountPage()
    expect(w.text()).toContain('metadataOnly')
    expect(w.text()).toContain('候选上架')
    expect(w.text()).toContain('每百万 token 绝对美元单价')
    expect(w.text()).toContain('同 modelKey 重新新增即恢复上架')
  })
})
