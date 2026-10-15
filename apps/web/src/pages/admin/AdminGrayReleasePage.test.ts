import { describe, expect, it, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminGrayReleasePage from './AdminGrayReleasePage.vue'

const { ElMessageBoxConfirm } = vi.hoisted(() => ({ ElMessageBoxConfirm: vi.fn(async (..._a: unknown[]) => 'confirm') }))

// 真实弹窗在 vitest 下永远 pending（沿用 AdminPricingPage.test.ts 已验证的部分 mock 先例）
vi.mock('element-plus', async (importOriginal) => {
  const mod = await importOriginal<typeof import('element-plus')>()
  return {
    ...mod,
    ElMessageBox: { ...mod.ElMessageBox, confirm: (...a: unknown[]) => ElMessageBoxConfirm(...a) },
  }
})

const { grayPreview, grayCreate, grayList, grayReport, grayPromote, grayRollback, listVersions } = vi.hoisted(() => ({
  grayPreview: vi.fn(),
  grayCreate: vi.fn(),
  grayList: vi.fn(),
  grayReport: vi.fn(),
  grayPromote: vi.fn(),
  grayRollback: vi.fn(),
  listVersions: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    pricingGray: {
      preview: (...a: unknown[]) => grayPreview(...a),
      create: (...a: unknown[]) => grayCreate(...a),
      list: (...a: unknown[]) => grayList(...a),
      report: (...a: unknown[]) => grayReport(...a),
      promote: (...a: unknown[]) => grayPromote(...a),
      rollback: (...a: unknown[]) => grayRollback(...a),
    },
    pricingVersions: {
      list: (...a: unknown[]) => listVersions(...a),
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

const releaseRow = (over: Record<string, unknown> = {}) => ({
  id: 'r-1',
  status: 'active',
  version: '2026.10-A',
  hits: 3,
  startsAt: '2026-10-14T00:00:00.000Z',
  endsAt: '2026-10-21T00:00:00.000Z',
  note: null,
  ...over,
})

const draftRow = (over: Record<string, unknown> = {}) => ({
  id: 'v-1',
  version: '2026.10-A',
  status: 'draft',
  note: null,
  entryCount: 2,
  publishedAt: null,
  createdAt: '2026-10-14T00:00:00.000Z',
  ...over,
})

type PageVm = {
  releases: unknown[]
  drafts: unknown[]
  formVersionId: string
  formRawInput: string
  formNote: string
  preview: { hits: { userId: string; phone: string }[]; misses: string[] } | null
  canCreate: boolean
  actionError: string
  reload: () => Promise<void>
  loadPreview: () => Promise<void>
  createGray: () => Promise<void>
  openReport: (id: string) => Promise<void>
  promote: (id: string) => Promise<void>
  rollbackRelease: (id: string) => Promise<void>
}

function mountPage() {
  return mount(AdminGrayReleasePage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

function createBtn(w: ReturnType<typeof mount>) {
  return w.find('[data-test="create-btn"]')
}

function previewBtn(w: ReturnType<typeof mount>) {
  const btn = w.findAll('button').find((b) => b.text().includes('预览命中'))
  if (!btn) throw new Error('未找到「预览命中」按钮')
  return btn
}

describe('AdminGrayReleasePage', () => {
  beforeEach(() => vi.clearAllMocks())

  // 本沙箱 vitest 冷启动慢：首挂载用例放宽 testTimeout（默认 5s 不够）
  it('渲染 release 列表（状态/窗口/命中数）+ draft 版本下拉选项', async () => {
    grayList.mockResolvedValue([
      releaseRow(),
      releaseRow({ id: 'r-2', status: 'promoted', version: '2026.09-B' }),
      releaseRow({ id: 'r-3', status: 'rolled_back', version: '2026.08-C' }),
    ])
    listVersions.mockResolvedValue([draftRow(), draftRow({ id: 'v-2', status: 'active' })])
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('2026.10-A')
    expect(w.text()).toContain('promoted')
    expect(w.text()).toContain('rolled_back')
    const vm = w.vm as unknown as PageVm
    expect(vm.drafts).toHaveLength(1)
  }, 20_000)

  it('预览命中：N 命中 / M 未命中显式展示，未命中号码逐个列出', async () => {
    grayList.mockResolvedValue([])
    listVersions.mockResolvedValue([draftRow()])
    grayPreview.mockResolvedValue({
      hits: [{ userId: 'u-1', phone: '13800000001' }],
      misses: ['13800000002', '13800000003'],
    })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    vm.formRawInput = '13800000001, 13800000002\n13800000003'
    await vm.loadPreview()
    await flushPromises()
    expect(grayPreview).toHaveBeenCalledWith('13800000001, 13800000002\n13800000003')
    expect(w.text()).toContain('命中 1 人 / 未命中 2 个')
    // 未命中号码逐个列出
    const missText = w.find('[data-test="miss-list"]').text()
    expect(missText).toContain('13800000002')
    expect(missText).toContain('13800000003')
  })

  it('防线：未预览 → 创建按钮禁用；0 命中 → 禁用；有命中 → 可用', async () => {
    grayList.mockResolvedValue([])
    listVersions.mockResolvedValue([draftRow()])
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    vm.formVersionId = 'v-1'

    // 未预览
    expect((createBtn(w).element as HTMLButtonElement).disabled).toBe(true)

    // 0 命中（全部未命中）→ 禁用 + 未命中逐个列出
    grayPreview.mockResolvedValue({ hits: [], misses: ['13800000002'] })
    vm.formRawInput = '13800000002'
    await vm.loadPreview()
    await flushPromises()
    expect((createBtn(w).element as HTMLButtonElement).disabled).toBe(true)
    expect(w.find('[data-test="preview-panel"]').text()).toContain('命中 0 人')
    expect(w.find('[data-test="miss-list"]').text()).toContain('13800000002')

    // 有命中 → 可用
    grayPreview.mockResolvedValue({ hits: [{ userId: 'u-1', phone: '13800000001' }], misses: [] })
    vm.formRawInput = '13800000001'
    await vm.loadPreview()
    await flushPromises()
    expect((createBtn(w).element as HTMLButtonElement).disabled).toBe(false)
  })

  it('防误伤：真实顺序（选版本 → 填名单 → 点预览）仍可创建，预览态不被误清', async () => {
    grayList.mockResolvedValue([])
    listVersions.mockResolvedValue([draftRow(), draftRow({ id: 'v-2', version: '2026.10-B' })])
    grayPreview.mockResolvedValue({ hits: [{ userId: 'u-1', phone: '13800000001' }], misses: ['13800000002'] })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm

    // 真实用户顺序：先选 draft 版本，再填名单
    vm.formVersionId = 'v-1'
    vm.formRawInput = '13800000001, 13800000002'
    await nextTick()

    // 预览必须是最后一个动作（watch 只在名单/版本「变化时」清 preview）
    await previewBtn(w).trigger('click')
    await flushPromises()

    expect(grayPreview).toHaveBeenCalledWith('13800000001, 13800000002')
    expect(vm.preview).not.toBeNull()
    expect(vm.canCreate).toBe(true)
    expect((createBtn(w).element as HTMLButtonElement).disabled).toBe(false)
    expect(w.find('[data-test="preview-panel"]').text()).toContain('命中 1 人')
  })

  it('防线：预览有命中后改名单 → 预览态立即作废、创建按钮回禁用', async () => {
    grayList.mockResolvedValue([])
    listVersions.mockResolvedValue([draftRow()])
    grayPreview.mockResolvedValue({ hits: [{ userId: 'u-1', phone: '13800000001' }], misses: [] })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    vm.formVersionId = 'v-1'

    // 名单 A → 预览 → 可创建
    vm.formRawInput = '13800000001'
    await nextTick()
    await vm.loadPreview()
    await flushPromises()
    expect(vm.preview).not.toBeNull()
    expect(vm.canCreate).toBe(true)
    expect((createBtn(w).element as HTMLButtonElement).disabled).toBe(false)

    // 名单 A 改成名单 B（未预览过）→ 陈旧命中数必须作废，否则面板显示旧命中数且按钮仍可点 → 服务端 400
    vm.formRawInput = '13800000009'
    await nextTick()

    expect(vm.preview).toBeNull()
    expect(vm.canCreate).toBe(false)
    expect((createBtn(w).element as HTMLButtonElement).disabled).toBe(true)
    expect(w.find('[data-test="preview-panel"]').exists()).toBe(false)
  })

  it('防线：预览有命中后改版本 → 预览态同样作废、创建按钮回禁用', async () => {
    grayList.mockResolvedValue([])
    listVersions.mockResolvedValue([draftRow(), draftRow({ id: 'v-2', version: '2026.10-B' })])
    grayPreview.mockResolvedValue({ hits: [{ userId: 'u-1', phone: '13800000001' }], misses: [] })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    vm.formRawInput = '13800000001'
    await nextTick()
    vm.formVersionId = 'v-1'
    await nextTick()
    await vm.loadPreview()
    await flushPromises()
    expect(vm.canCreate).toBe(true)

    // 换到另一个 draft 版本 → 针对 v-1 的命中数对新版本无效
    vm.formVersionId = 'v-2'
    await nextTick()

    expect(vm.preview).toBeNull()
    expect(vm.canCreate).toBe(false)
    expect((createBtn(w).element as HTMLButtonElement).disabled).toBe(true)
  })

  it('创建灰度：POST rawInput/窗口，成功后刷新并重置预览', async () => {
    grayList.mockResolvedValue([])
    listVersions.mockResolvedValue([draftRow()])
    grayPreview.mockResolvedValue({ hits: [{ userId: 'u-1', phone: '13800000001' }], misses: [] })
    grayCreate.mockResolvedValue({ releaseId: 'r-new', version: '2026.10-A', hits: 1, window: { startsAt: 'x', endsAt: 'y' } })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    vm.formVersionId = 'v-1'
    vm.formRawInput = '13800000001'
    vm.formNote = '试点'
    await vm.loadPreview()
    await vm.createGray()
    await flushPromises()
    expect(grayCreate).toHaveBeenCalledWith({
      versionId: 'v-1',
      rawInput: '13800000001',
      startsAt: undefined,
      endsAt: undefined,
      note: '试点',
    })
    expect(vm.preview).toBeNull()
    expect(grayList).toHaveBeenCalledTimes(2)
  })

  it('报告抽屉：全字段渲染（含 refund 行金额，直接展示不扣回）', async () => {
    grayList.mockResolvedValue([releaseRow()])
    listVersions.mockResolvedValue([])
    grayReport.mockResolvedValue({
      releaseId: 'r-1',
      version: '2026.10-A',
      status: 'active',
      hits: 3,
      txCount: 10,
      txAmountByCategory: { consume: -500, refund: 120 },
      refundCount: 2,
      byUser: [{ userId: 'u-1', consumeCount: 4, consumeTotal: -200 }],
    })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    await vm.openReport('r-1')
    await flushPromises()
    expect(grayReport).toHaveBeenCalledWith('r-1')
    const panel = w.find('[data-test="report-panel"]')
    expect(panel.text()).toContain('r-1')
    expect(panel.text()).toContain('10')
    expect(panel.text()).toContain('退款 2 笔')
    expect(panel.text()).toContain('consume=-500')
    expect(panel.text()).toContain('refund=120')
    expect(panel.text()).toContain('u-1')
  })

  it('promote / rollback：二次确认后调用对应端点', async () => {
    grayList.mockResolvedValue([releaseRow()])
    listVersions.mockResolvedValue([])
    grayPromote.mockResolvedValue({ version: '2026.10-A' })
    grayRollback.mockResolvedValue(undefined)
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    await vm.promote('r-1')
    expect(ElMessageBoxConfirm).toHaveBeenCalledTimes(1)
    expect(grayPromote).toHaveBeenCalledWith('r-1')
    await vm.rollbackRelease('r-1')
    expect(ElMessageBoxConfirm).toHaveBeenCalledTimes(2)
    expect(grayRollback).toHaveBeenCalledWith('r-1')
  })

  it('关停确认文案与实现对齐：不再承诺「立即」，改为缓存窗口上限（终审 I3）', async () => {
    grayList.mockResolvedValue([releaseRow()])
    listVersions.mockResolvedValue([])
    grayRollback.mockResolvedValue(undefined)
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as PageVm
    await vm.rollbackRelease('r-1')
    const [msg] = ElMessageBoxConfirm.mock.calls.at(-1) as string[]
    // 服务端写路径已 invalidate 缓存（实际下一笔即生效），但 UI 只承诺可验证的
    // 上限，不写「立即」——文案必须与实现的上界一致，不能夸大。
    expect(msg).toContain('30s')
    expect(msg).not.toContain('立即回到全局价目')
  })
})
