import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import AdminPricingHubPage from './AdminPricingHubPage.vue'

// 定价中心页测试（spec: docs/design/2026-11-15-pricing-console-redesign.md §5）：
// - 卡片墙渲染：卡片数 = 在售模型数；默认选中首个非就绪模型（填数优先）；
// - saveRecord：只提交已填档位 + 自持利润率（R3/R4），空档位不提交；
// - refreshPricing：rebuild → 建 draft → 物化 → 门禁预览全链调用。

const { listCostRecords, updateCostRecord, rebuildSubjects, materializeDraft, getReadiness, versionsList, createDraft, collectCostRates, versionsDiff, versionsPublish, versionsRollback, ElMessageBoxConfirm } = vi.hoisted(() => ({
  listCostRecords: vi.fn(),
  updateCostRecord: vi.fn(),
  rebuildSubjects: vi.fn(),
  materializeDraft: vi.fn(),
  getReadiness: vi.fn(),
  versionsList: vi.fn(),
  createDraft: vi.fn(),
  collectCostRates: vi.fn(),
  versionsDiff: vi.fn(),
  versionsPublish: vi.fn(),
  versionsRollback: vi.fn(),
  ElMessageBoxConfirm: vi.fn(async (..._a: unknown[]) => 'confirm'),
}))

// 真实弹窗在 vitest 下永远 pending（沿用 AdminPricingVersionsPage.test.ts 已验证的部分 mock 先例）
vi.mock('element-plus', async (importOriginal) => {
  const mod = await importOriginal<typeof import('element-plus')>()
  return {
    ...mod,
    ElMessageBox: { ...mod.ElMessageBox, confirm: (...a: unknown[]) => ElMessageBoxConfirm(...a) },
  }
})

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    pricingS1: {
      listCostRecords: (...a: unknown[]) => listCostRecords(...a),
      updateCostRecord: (...a: unknown[]) => updateCostRecord(...a),
      rebuildSubjects: (...a: unknown[]) => rebuildSubjects(...a),
      materializeDraft: (...a: unknown[]) => materializeDraft(...a),
      getReadiness: (...a: unknown[]) => getReadiness(...a),
      collectCostRates: (...a: unknown[]) => collectCostRates(...a),
    },
    pricingVersions: {
      list: (...a: unknown[]) => versionsList(...a),
      createDraft: (...a: unknown[]) => createDraft(...a),
      diff: (...a: unknown[]) => versionsDiff(...a),
      publish: (...a: unknown[]) => versionsPublish(...a),
      rollback: (...a: unknown[]) => versionsRollback(...a),
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
    { spec: '480p', label: '480p（元/秒）', unit: 'per_second', unitQuantity: 1, costYuan: null, perVideoDerived: null, materializedCredits: null, creditsByDuration: null },
    {
      spec: '768p',
      label: '768p（元/秒）',
      unit: 'per_second',
      unitQuantity: 1,
      costYuan: null,
      perVideoDerived: 0.572,
      materializedCredits: null,
      creditsByDuration: [
        { duration: 5, credits: 315 },
        { duration: 10, credits: 630 },
      ],
    },
    { spec: '2k', label: '2k（元/秒）', unit: 'per_second', unitQuantity: 1, costYuan: null, perVideoDerived: null, materializedCredits: null, creditsByDuration: null },
  ],
  subjectsTotal: 12,
  missingSpecs: ['480p:4s'],
  status: 'missing',
  materializedVersion: 'v-final2-123837',
}

const imageRecord = {
  modelKey: 'img-a',
  displayName: '图像 A',
  modality: 'image',
  audioKind: null,
  channel: 'gateway-openai-compat',
  profitPct: 10,
  tiers: [{ spec: '1K', label: '1K（元/张）', unit: 'per_image', unitQuantity: 1, costYuan: 0.3, perVideoDerived: null, materializedCredits: 33, creditsByDuration: null }],
  subjectsTotal: 9,
  missingSpecs: [],
  status: 'ready',
  materializedVersion: 'v-final2-123837',
}

type HubVm = {
  selectedKey: string
  tierValues: Record<string, string>
  profitPctValue: number | null
  lastMaterialize: { added: number } | null
  actionError: string
  saveRecord: () => Promise<void>
  refreshPricing: () => Promise<void>
  syncPreviewRun: () => Promise<void>
  syncApply: () => Promise<void>
  syncPreview: unknown
  syncDialogVisible: boolean
  // P3-A 发布面板
  currentDraftId: string | null
  hubDiff: { increaseCount: number; decreaseCount: number; newCount: number; draftVersion: string; maxIncrease: { matchKey: string; from: number; to: number; pct: number } | null; floorViolations: unknown[]; missingCost: string[] } | null
  loadDiff: () => Promise<void>
  publishFromHub: () => Promise<void>
  rollbackFromHub: () => Promise<void>
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

  it('P1.6 物化积分：video 按时长枚举+每秒折算，image 单值，无物化显示「—」', async () => {
    listCostRecords.mockResolvedValue([videoRecord])
    const w = mountPage()
    await flushPromises()
    // 默认选中首个非就绪模型（v-a），首个档位 480p（无物化条目）
    expect(w.text()).toContain('物化后扣费积分：—')
    expect(w.text()).toContain('（v-final2-123837）')
    // 切到 768p 档位：每秒折算 63 分 + 时长枚举
    const vm = w.vm as unknown as { selectedTier: string }
    vm.selectedTier = '768p'
    await flushPromises()
    expect(w.text()).toContain('约 63 分/秒')
    expect(w.text()).toContain('5s=315分')
    expect(w.text()).toContain('10s=630分')
  })

  it('P1.6 物化积分：image 档位显示单值（N 分/张）', async () => {
    listCostRecords.mockResolvedValue([imageRecord])
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('物化后扣费积分：33 分/张')
  })

  it('同步上游价目：dryRun 预览 → 确认落库（两段式 D4）', async () => {
    listCostRecords.mockResolvedValue([videoRecord])
    const preview = {
      ranAt: 't', dryRun: true, written: 0, keptManual: [],
      adapters: [{ upstream: 'zhipu', status: 'ok', candidates: [{ modelKey: 'cogvideox-flash', spec: '480p', costYuan: 0, evidence: { url: 'u', note: '免费' } }], skips: [] }],
      uncovered: [],
    }
    collectCostRates.mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, dryRun: false, written: 1 })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as HubVm
    await vm.syncPreviewRun()
    expect(collectCostRates).toHaveBeenNthCalledWith(1, { dryRun: true })
    expect(vm.syncDialogVisible).toBe(true)
    expect(vm.syncPreview).not.toBeNull()
    await vm.syncApply()
    expect(collectCostRates).toHaveBeenNthCalledWith(2, { dryRun: false })
    expect(vm.syncDialogVisible).toBe(false)
  })
})
const diffData = (over: Record<string, unknown> = {}) => ({
  draftVersion: 'v-hub',
  activeVersion: 'v-active',
  added: 0,
  changed: 3,
  unchanged: 100,
  maxIncrease: { matchKey: 'image|img-a|2K', from: 11, to: 22, pct: 1.0 },
  maxDecrease: null,
  increaseCount: 2,
  decreaseCount: 1,
  newCount: 0,
  floorViolations: [],
  missingCost: [],
  ...over,
})

describe('P3-A hub 发布面板（上收 diff/发布/回滚/公告开关）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ElMessageBoxConfirm.mockClear()
  })

  it('refreshPricing 后 draftId 落位；影响面预览拉 diff 并渲染涨跌档数', async () => {
    listCostRecords.mockResolvedValue([imageRecord])
    versionsList.mockResolvedValue([]) // 无既有 draft → createDraft
    createDraft.mockResolvedValue({ id: 'draft-1', version: 'v-hub', entries: 100 })
    materializeDraft.mockResolvedValue({ added: 1, changed: 2, unchanged: 97, missingCost: [], addedKeys: [], changedKeys: [] } as never)
    getReadiness.mockResolvedValue({ ok: true, violations: [] })
    versionsDiff.mockResolvedValue(diffData())
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as HubVm
    await vm.refreshPricing()
    await flushPromises()
    expect(vm.currentDraftId).toBe('draft-1')
    await vm.loadDiff()
    await flushPromises()
    expect(versionsDiff).toHaveBeenCalledWith('draft-1')
    expect(w.text()).toContain('涨价 2 档')
    expect(w.text()).toContain('降价 1 档')
  })

  it('发布：二次确认含公告开关（默认 false）+ 涨幅文本；确认后 publish(draftId,false) 并置空 draft', async () => {
    listCostRecords.mockResolvedValue([imageRecord])
    versionsList.mockResolvedValue([])
    createDraft.mockResolvedValue({ id: 'draft-1', version: 'v-hub', entries: 100 })
    materializeDraft.mockResolvedValue({ added: 1, changed: 2, unchanged: 97, missingCost: [], addedKeys: [], changedKeys: [] } as never)
    getReadiness.mockResolvedValue({ ok: true, violations: [] })
    versionsDiff.mockResolvedValue(diffData())
    versionsPublish.mockResolvedValue({ version: 'v-hub', announcementId: null })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as HubVm
    await vm.refreshPricing()
    await flushPromises()
    await vm.publishFromHub()
    await flushPromises()
    expect(ElMessageBoxConfirm).toHaveBeenCalledTimes(1)
    const [msg] = ElMessageBoxConfirm.mock.calls[0] as unknown[]
    expect(JSON.stringify(msg)).toContain('最大涨幅')
    expect(JSON.stringify(msg)).toContain('推送调价公告给用户')
    expect(versionsPublish).toHaveBeenCalledWith('draft-1', false)
    expect(vm.currentDraftId).toBe(null)
  })

  it('发布禁用态：未生成过价目表（draftId=null）→ publish/diff 早退不发请求 + 引导文案', async () => {
    listCostRecords.mockResolvedValue([imageRecord])
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as HubVm
    expect(vm.currentDraftId).toBe(null)
    await vm.loadDiff()
    await vm.publishFromHub()
    await flushPromises()
    expect(versionsDiff).not.toHaveBeenCalled()
    expect(versionsPublish).not.toHaveBeenCalled()
    expect(ElMessageBoxConfirm).not.toHaveBeenCalled()
    expect(w.text()).toContain('先点「生成价目表」')
  })

  it('回滚：二次确认 → rollback → 成功提示', async () => {
    listCostRecords.mockResolvedValue([imageRecord])
    versionsRollback.mockResolvedValue({ version: '2026.09-B' })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as HubVm
    await vm.rollbackFromHub()
    await flushPromises()
    expect(ElMessageBoxConfirm).toHaveBeenCalledTimes(1)
    expect(versionsRollback).toHaveBeenCalledTimes(1)
  })
})
