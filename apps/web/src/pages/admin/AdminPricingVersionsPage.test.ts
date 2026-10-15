import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminPricingVersionsPage from './AdminPricingVersionsPage.vue'

const { ElMessageBoxConfirm } = vi.hoisted(() => ({ ElMessageBoxConfirm: vi.fn(async (..._a: unknown[]) => 'confirm') }))

// 真实弹窗在 vitest 下永远 pending（沿用 AdminPricingPage.test.ts 已验证的部分 mock 先例）
vi.mock('element-plus', async (importOriginal) => {
  const mod = await importOriginal<typeof import('element-plus')>()
  return {
    ...mod,
    ElMessageBox: { ...mod.ElMessageBox, confirm: (...a: unknown[]) => ElMessageBoxConfirm(...a) },
  }
})

const { listVersions, createDraft, getDraft, putEntries, diffSummary, publish, rollback } = vi.hoisted(() => ({
  listVersions: vi.fn(),
  createDraft: vi.fn(),
  getDraft: vi.fn(),
  putEntries: vi.fn(),
  diffSummary: vi.fn(),
  publish: vi.fn(),
  rollback: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    pricingVersions: {
      list: (...a: unknown[]) => listVersions(...a),
      createDraft: (...a: unknown[]) => createDraft(...a),
      get: (...a: unknown[]) => getDraft(...a),
      putEntries: (...a: unknown[]) => putEntries(...a),
      diff: (...a: unknown[]) => diffSummary(...a),
      publish: (...a: unknown[]) => publish(...a),
      rollback: (...a: unknown[]) => rollback(...a),
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

const versionRow = (over: Record<string, unknown> = {}) => ({
  id: 'v-1',
  version: '2026.10-A',
  status: 'draft',
  note: '调价草案',
  entryCount: 2,
  publishedAt: null,
  createdAt: '2026-10-14T00:00:00.000Z',
  ...over,
})

const entry = (over: Record<string, unknown> = {}) => ({
  matchKey: 'gpt-4o',
  capability: 'text',
  credits: 100,
  basis: 'legacy-equivalent',
  costRateId: null,
  ...over,
})

const diffData = (over: Record<string, unknown> = {}) => ({
  draftVersion: '2026.10-A',
  activeVersion: '2026.09-B',
  added: 1,
  removed: 0,
  changed: 2,
  unchanged: 3,
  maxIncrease: { matchKey: 'gpt-4o', from: 100, to: 150, pct: 0.5 },
  maxDecrease: null,
  floorViolations: [],
  missingCost: [],
  noCostCoverage: [],
  ...over,
})

type PageVm = {
  versions: unknown[]
  draft: { id: string; version: string; status: string; entries: { matchKey: string; credits: number }[] } | null
  editCredits: Record<string, string>
  diff: Record<string, unknown> | null
  actionError: string
  draftVersion: string
  draftNote: string
  createDraft: () => Promise<void>
  openDraft: (id: string) => Promise<void>
  saveEntries: () => Promise<void>
  loadDiff: () => Promise<void>
  publish: () => Promise<void>
  rollback: () => Promise<void>
}

function mountPage() {
  return mount(AdminPricingVersionsPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminPricingVersionsPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('渲染版本列表 + 状态徽标 draft/active/archived', async () => {
    listVersions.mockResolvedValue([
      versionRow(),
      versionRow({ id: 'v-2', version: '2026.09-B', status: 'active', publishedAt: '2026-09-01T00:00:00.000Z' }),
      versionRow({ id: 'v-3', version: '2026.08-C', status: 'archived' }),
    ])
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('2026.10-A')
    expect(w.text()).toContain('2026.09-B')
    expect(w.text()).toContain('2026.08-C')
    expect(w.findAll('.el-tag').map((t) => t.text())).toEqual(expect.arrayContaining(['draft', 'active', 'archived']))
  }, 20_000) // 本沙箱 vitest 冷启动慢：首挂载用例放宽 testTimeout

  it('建草案：version/note 非空校验 + POST 后刷新并打开草案', async () => {
    listVersions.mockResolvedValue([versionRow()])
    createDraft.mockResolvedValue({ id: 'v-new', version: '2026.11-A', entries: 3 })
    getDraft.mockResolvedValue({
      id: 'v-new',
      version: '2026.11-A',
      status: 'draft',
      note: 'n',
      entries: [entry()],
    })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm

    vm.draftVersion = ' '
    vm.draftNote = 'n'
    await vm.createDraft()
    expect(createDraft).not.toHaveBeenCalled()
    expect(vm.actionError).toContain('非空')

    vm.draftVersion = '2026.11-A'
    vm.draftNote = 'n'
    await vm.createDraft()
    await flushPromises()
    expect(createDraft).toHaveBeenCalledWith('2026.11-A', 'n')
    expect(getDraft).toHaveBeenCalledWith('v-new')
  })

  it('草案行内改 credits 保存 → PUT 正整数；非法输入前端拦截不发请求', async () => {
    listVersions.mockResolvedValue([versionRow()])
    getDraft.mockResolvedValue({
      id: 'v-1',
      version: '2026.10-A',
      status: 'draft',
      note: 'n',
      entries: [entry(), entry({ matchKey: 'claude', credits: 50 })],
    })
    putEntries.mockResolvedValue({ written: 2 })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    await vm.openDraft('v-1')
    expect(vm.editCredits['gpt-4o']).toBe('100')

    vm.editCredits['gpt-4o'] = 'abc'
    await vm.saveEntries()
    expect(putEntries).not.toHaveBeenCalled()
    expect(vm.actionError).toContain('正整数')

    vm.editCredits['gpt-4o'] = '120'
    vm.editCredits['claude'] = '50'
    await vm.saveEntries()
    await flushPromises()
    expect(putEntries).toHaveBeenCalledWith(
      'v-1',
      expect.arrayContaining([
        expect.objectContaining({ matchKey: 'gpt-4o', credits: 120 }),
        expect.objectContaining({ matchKey: 'claude', credits: 50 }),
      ]),
    )
  })

  it('diff 面板：地板违规/成本缺失标红、无成本覆盖标注', async () => {
    listVersions.mockResolvedValue([versionRow()])
    getDraft.mockResolvedValue({ id: 'v-1', version: '2026.10-A', status: 'draft', note: 'n', entries: [entry()] })
    diffSummary.mockResolvedValue(
      diffData({
        floorViolations: [{ matchKey: 'gpt-4o', credits: 100, floor: 105 }],
        missingCost: ['m-x'],
        noCostCoverage: ['gpt-4o'],
      }),
    )
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    await vm.openDraft('v-1')
    await vm.loadDiff()
    await flushPromises()
    expect(w.text()).toContain('地板违规 1 条')
    expect(w.text()).toContain('credits=100')
    expect(w.text()).toContain('floor=105')
    expect(w.text()).toContain('成本费率缺失')
    expect(w.text()).toContain('m-x')
    expect(w.text()).toContain('无成本覆盖')
    // 标红防线：diff 面板内存在 danger 文本节点（先断言节点数，避免 findAll 空转成空壳断言）
    const dangerNodes = w.findAll('[data-test="floor-violations"], [data-test="missing-cost"]')
    expect(dangerNodes).toHaveLength(2)
    for (const n of dangerNodes) {
      expect(n.classes()).toContain('text-danger')
    }
  })

  it('发布：二次确认弹窗展示 maxIncrease，确认后调用 publish', async () => {
    listVersions.mockResolvedValue([versionRow()])
    getDraft.mockResolvedValue({ id: 'v-1', version: '2026.10-A', status: 'draft', note: 'n', entries: [entry()] })
    diffSummary.mockResolvedValue(diffData())
    publish.mockResolvedValue({ version: '2026.10-A' })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    await vm.openDraft('v-1')
    await vm.publish()
    await flushPromises()
    expect(ElMessageBoxConfirm).toHaveBeenCalledTimes(1)
    const [msg] = ElMessageBoxConfirm.mock.calls[0] as string[]
    expect(msg).toContain('最大涨幅')
    expect(msg).toContain('gpt-4o')
    expect(msg).toContain('+50.0%')
    expect(publish).toHaveBeenCalledWith('v-1')
  })

  it('回滚：二次确认后调用 rollback', async () => {
    listVersions.mockResolvedValue([versionRow()])
    rollback.mockResolvedValue({ version: '2026.09-B' })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    await vm.rollback()
    await flushPromises()
    expect(ElMessageBoxConfirm).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledTimes(1)
  })
})
