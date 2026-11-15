import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import AdminPricingHubPage from './AdminPricingHubPage.vue'

// 定价中心页测试（spec: docs/design/2026-11-15-pricing-console-redesign.md §5）：
// - 卡片墙渲染：卡片数 = 在售模型数；默认选中首个非就绪模型（填数优先）；
// - saveRecord：只提交已填档位 + 自持利润率（R3/R4），空档位不提交；
// - refreshPricing：rebuild → 建 draft → 物化 → 门禁预览全链调用。

const { listCostRecords, updateCostRecord, rebuildSubjects, materializeDraft, getReadiness, versionsList, createDraft } = vi.hoisted(() => ({
  listCostRecords: vi.fn(),
  updateCostRecord: vi.fn(),
  rebuildSubjects: vi.fn(),
  materializeDraft: vi.fn(),
  getReadiness: vi.fn(),
  versionsList: vi.fn(),
  createDraft: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    pricingS1: {
      listCostRecords: (...a: unknown[]) => listCostRecords(...a),
      updateCostRecord: (...a: unknown[]) => updateCostRecord(...a),
      rebuildSubjects: (...a: unknown[]) => rebuildSubjects(...a),
      materializeDraft: (...a: unknown[]) => materializeDraft(...a),
      getReadiness: (...a: unknown[]) => getReadiness(...a),
    },
    pricingVersions: {
      list: (...a: unknown[]) => versionsList(...a),
      createDraft: (...a: unknown[]) => createDraft(...a),
    },
  },
  AdminApiError: class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

const videoRecord = {
  modelKey: 'v-a',
  displayName: '视频 A',
  modality: 'video',
  audioKind: null,
  channel: 'gateway-openai-compat',
  profitPct: null,
  tiers: [
    { spec: '480p', label: '480p（元/秒）', unit: 'per_second', unitQuantity: 1, costYuan: null, perVideoDerived: null },
    { spec: '768p', label: '768p（元/秒）', unit: 'per_second', unitQuantity: 1, costYuan: null, perVideoDerived: 0.572 },
    { spec: '2k', label: '2k（元/秒）', unit: 'per_second', unitQuantity: 1, costYuan: null, perVideoDerived: null },
  ],
  subjectsTotal: 12,
  missingSpecs: ['480p:4s'],
  status: 'missing',
}

const imageRecord = {
  modelKey: 'img-a',
  displayName: '图像 A',
  modality: 'image',
  audioKind: null,
  channel: 'gateway-openai-compat',
  profitPct: 10,
  tiers: [{ spec: '1K', label: '1K（元/张）', unit: 'per_image', unitQuantity: 1, costYuan: 0.3, perVideoDerived: null }],
  subjectsTotal: 9,
  missingSpecs: [],
  status: 'ready',
}

type HubVm = {
  selectedKey: string
  tierValues: Record<string, string>
  profitPctValue: number | null
  lastMaterialize: { added: number } | null
  actionError: string
  saveRecord: () => Promise<void>
  refreshPricing: () => Promise<void>
}

function mountPage() {
  return mount(AdminPricingHubPage, {
    global: {
      plugins: [ElementPlus],
      stubs: { 'router-link': true, 'el-input-number': true },
    },
  })
}

describe('AdminPricingHubPage（定价中心）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('卡片墙：卡片数=在售模型数，默认选中首个非就绪模型并预填 legacy 折算参考值', async () => {
    listCostRecords.mockResolvedValue([imageRecord, videoRecord])
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('视频 A')
    expect(w.text()).toContain('图像 A')
    const vm = w.vm as unknown as HubVm
    expect(vm.selectedKey).toBe('v-a')
    expect(vm.tierValues['768p']).toBe('0.572')
    expect(vm.profitPctValue).toBe(10)
  })

  it('saveRecord：只提交已填档位 + 自持利润率；空档位不提交', async () => {
    listCostRecords.mockResolvedValue([videoRecord])
    updateCostRecord.mockResolvedValue({ modelKey: 'v-a', savedTiers: 1, profitBp: 1200 })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as HubVm
    vm.tierValues['768p'] = '0.572'
    vm.profitPctValue = 12
    await vm.saveRecord()
    expect(updateCostRecord).toHaveBeenCalledTimes(1)
    expect(updateCostRecord).toHaveBeenCalledWith('v-a', { tiers: [{ spec: '768p', costYuan: 0.572 }], profitPct: 12 })
  })

  it('saveRecord：全部档位为空时拒绝并提示，不发请求（R3 守卫）', async () => {
    listCostRecords.mockResolvedValue([videoRecord])
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as HubVm
    vm.tierValues = { '480p': '', '768p': '', '2k': '' }
    await vm.saveRecord()
    expect(updateCostRecord).not.toHaveBeenCalled()
    expect(vm.actionError).toContain('至少填写一个档位')
  })

  it('refreshPricing：rebuild → 建 draft → 物化 → 门禁预览', async () => {
    listCostRecords.mockResolvedValue([videoRecord])
    versionsList.mockResolvedValue([])
    createDraft.mockResolvedValue({ id: 'draft-1', version: 'v-hub', status: 'draft' })
    materializeDraft.mockResolvedValue({ added: 5, changed: 2, unchanged: 3, missingCost: [] })
    getReadiness.mockResolvedValue({ ok: true, violations: [] })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as HubVm
    await vm.refreshPricing()
    expect(rebuildSubjects).toHaveBeenCalledTimes(1)
    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(materializeDraft).toHaveBeenCalledWith('draft-1')
    expect(vm.lastMaterialize?.added).toBe(5)
  })
})
