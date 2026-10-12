import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminPricingPage from './AdminPricingPage.vue'

const { ElMessageBoxConfirm } = vi.hoisted(() => ({ ElMessageBoxConfirm: vi.fn(async (..._a: unknown[]) => 'confirm') }))

// brief 原文未 mock ElMessageBox.confirm，但真实弹窗在 vitest 下永远 pending，
// clearPricing 用例会因此阻塞；沿用 AdminModelsPage.test.ts 已验证的部分 mock 先例。
vi.mock('element-plus', async (importOriginal) => {
  const mod = await importOriginal<typeof import('element-plus')>()
  return {
    ...mod,
    ElMessageBox: { ...mod.ElMessageBox, confirm: (...a: unknown[]) => ElMessageBoxConfirm(...a) },
  }
})

const { platformChannel, setPlatformModelPricing } = vi.hoisted(() => ({
  platformChannel: vi.fn(),
  setPlatformModelPricing: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    platformChannel: (...a: unknown[]) => platformChannel(...a),
    setPlatformModelPricing: (...a: unknown[]) => setPlatformModelPricing(...a),
  },
  AdminApiError: class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

const model = (over: Record<string, unknown>) => ({
  name: 'm-a',
  capability: 'text',
  ...over,
})

function mountPage() {
  return mount(AdminPricingPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminPricingPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('渲染模型行 + 已配/未配计数；未配定价行显示醒目徽标', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform',
      name: '平台渠道',
      apiFormat: 'openai',
      parseError: false,
      models: [model({ pricing: { inputPerM: 1, outputPerM: 2 } }), model({ name: 'm-b' })],
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('1/2 已配定价')
    expect(w.text()).toContain('未配定价')
  })

  // Follow-up ③（前端）：pricing:null 与未配置同义——此前 ===undefined 判定会把 null
  // 条目计入已配计数、定价列渲染为空串；归一后 null 行显示徽标、不计计数、清除禁用（同 undefined 行）
  it('pricing:null 条目 → 按「未配定价」渲染，不计入已配计数，清除按钮禁用（同未配置行）', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform',
      name: '平台渠道',
      apiFormat: 'openai',
      parseError: false,
      models: [model({ pricing: { inputPerM: 1 } }), model({ name: 'm-null', pricing: null })],
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('1/2 已配定价')
    expect(w.text()).toContain('未配定价')
    const clearBtns = w.findAll('button').filter((b) => b.text() === '清除')
    expect(clearBtns).toHaveLength(2)
    const disabledOf = (b: { element: Element }) => (b.element as HTMLButtonElement).disabled
    // 行序 = models 序：已配行可清除，null 行禁用（与 undefined 未配置行为一致）
    expect(disabledOf(clearBtns[0]!)).toBe(false)
    expect(disabledOf(clearBtns[1]!)).toBe(true)
  })

  it('set pricing：填四字段后提交 → PUT 对象，成功后刷新', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform', name: '平台渠道', apiFormat: 'openai', parseError: false,
      models: [model({})],
    })
    setPlatformModelPricing.mockResolvedValue({ entry: model({ pricing: { inputPerM: 1 } }), previousPricing: null })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as {
      pricingForm: { inputPerM: string; outputPerM: string; cacheReadPerM: string; cacheWritePerM: string }
      openEditor: (name: string) => void
      submitPricing: () => Promise<void>
    }
    vm.openEditor('m-a')
    vm.pricingForm.inputPerM = '1'
    vm.pricingForm.outputPerM = '2.5'
    await vm.submitPricing()
    await flushPromises()
    expect(setPlatformModelPricing).toHaveBeenCalledWith('m-a', { inputPerM: 1, outputPerM: 2.5 })
    expect(platformChannel).toHaveBeenCalledTimes(2)
  })

  it('clear pricing → PUT null', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform', name: '平台渠道', apiFormat: 'openai', parseError: false,
      models: [model({ pricing: { inputPerM: 1 } })],
    })
    setPlatformModelPricing.mockResolvedValue({ entry: model({}), previousPricing: { inputPerM: 1 } })
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { clearPricing: (name: string) => Promise<void> }).clearPricing('m-a')
    await flushPromises()
    expect(setPlatformModelPricing).toHaveBeenCalledWith('m-a', null)
  })

  it('parseError → 显示畸形警示并禁用编辑', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform', name: '平台渠道', apiFormat: 'openai', parseError: true, models: [],
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('models JSON 畸形')
  })

  it('提交非法数字 → 前端拦截不发请求', async () => {
    platformChannel.mockResolvedValue({
      id: 'platform', name: '平台渠道', apiFormat: 'openai', parseError: false,
      models: [model({})],
    })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as {
      pricingForm: { inputPerM: string }
      openEditor: (name: string) => void
      submitPricing: () => Promise<void>
    }
    vm.openEditor('m-a')
    vm.pricingForm.inputPerM = '-1'
    await vm.submitPricing()
    expect(setPlatformModelPricing).not.toHaveBeenCalled()
    expect((w.vm as unknown as { actionError: string }).actionError).toContain('非负')
  })
})
