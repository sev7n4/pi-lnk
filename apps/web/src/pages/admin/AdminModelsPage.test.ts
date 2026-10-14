import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminModelsPage from './AdminModelsPage.vue'

const { ElMessageBoxConfirm } = vi.hoisted(() => ({ ElMessageBoxConfirm: vi.fn(async (..._a: unknown[]) => 'confirm') }))

// vue-router mock：route.query 可变（预填/筛选回填用例），router.replace/push 记录调用
const routeState = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  replace: vi.fn(async () => ({})),
  push: vi.fn(async () => ({})),
}))
vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ replace: routeState.replace, push: routeState.push }),
}))

// brief 原文用 vi.spyOn(await import('element-plus'), 'ElMessageBox')，但 vitest 下
// ESM namespace 不可 reconfigure（"Module namespace is not configurable"），必然抛错；
// 改为等价意图的部分 mock：确认弹窗默认 resolve，断言与数据驱动不变。
vi.mock('element-plus', async (importOriginal) => {
  const mod = await importOriginal<typeof import('element-plus')>()
  return {
    ...mod,
    ElMessageBox: { ...mod.ElMessageBox, confirm: (...a: unknown[]) => ElMessageBoxConfirm(...a) },
  }
})

const { listCatalog, createCatalogEntry, deleteCatalogEntry, setDefault } = vi.hoisted(() => ({
  listCatalog: vi.fn(),
  createCatalogEntry: vi.fn(),
  deleteCatalogEntry: vi.fn(),
  setDefault: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    listCatalog: (...a: unknown[]) => listCatalog(...a),
    createCatalogEntry: (...a: unknown[]) => createCatalogEntry(...a),
    updateCatalogEntry: vi.fn(),
    deleteCatalogEntry: (...a: unknown[]) => deleteCatalogEntry(...a),
    setDefault: (...a: unknown[]) => setDefault(...a),
  },
  AdminApiError: class extends Error {
    status: number
    payload?: unknown
    constructor(message: string, status: number, payload?: unknown) {
      super(message)
      this.status = status
      this.payload = payload
    }
  },
}))

const entry = (over: Record<string, unknown>) => ({
  id: 'id-1',
  modelKey: 'm-1',
  displayName: 'Model One',
  gatewayModelId: 'gw-1',
  modality: 'text',
  providerBinding: 'gateway-openai-compat',
  audioKind: null,
  voices: null,
  params: {},
  defaults: null,
  deletedAt: null,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  ...over,
})

function mountPage() {
  return mount(AdminModelsPage, { global: { plugins: [ElementPlus, setActivePinia(createPinia())] } })
}

describe('AdminModelsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.query = {}
    routeState.replace.mockClear()
    routeState.push.mockClear()
  })

  it('加载目录并渲染行；软删行带已下架标记', async () => {
    listCatalog.mockResolvedValue({
      version: 7,
      entries: [entry({}), entry({ id: 'id-2', modelKey: 'm-2', deletedAt: '2026-10-10T00:00:00.000Z' })],
    })
    const w = mountPage()
    await flushPromises()
    const text = w.text()
    expect(text).toContain('m-1')
    expect(text).toContain('m-2')
    expect(text).toContain('已下架')
    expect(text).toContain('7') // 版本号
  })

  it('删除需确认，确认后调用 deleteCatalogEntry 并刷新', async () => {
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({})] })
    deleteCatalogEntry.mockResolvedValue({ version: 8, id: 'id-1', modelKey: 'm-1' })
    // 简化：直接驱动 removeEntry（组件把确认+执行封装在方法里，测试通过数据驱动验证调用）
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { removeEntry: (id: string, modelKey: string) => Promise<void> }).removeEntry('id-1', 'm-1')
    await flushPromises()
    expect(ElMessageBoxConfirm).toHaveBeenCalled()
    expect(deleteCatalogEntry).toHaveBeenCalledWith('id-1')
    expect(listCatalog).toHaveBeenCalledTimes(2)
  })

  it('删除失败（400/409 防呆）→ 展示服务端 message，不刷新', async () => {
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({})] })
    const { AdminApiError } = await import('@/services/admin-api')
    deleteCatalogEntry.mockRejectedValue(new AdminApiError('m-1 是默认模型，禁止下架', 400))
    const w = mountPage()
    await flushPromises()
    await (w.vm as unknown as { removeEntry: (id: string, modelKey: string) => Promise<void> }).removeEntry('id-1', 'm-1')
    await flushPromises()
    expect((w.vm as unknown as { actionError: string }).actionError).toContain('禁止下架')
    expect(listCatalog).toHaveBeenCalledTimes(1)
  })

  it('新增成功：submitForm 调用 createCatalogEntry，关闭弹窗并刷新', async () => {
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({})] })
    createCatalogEntry.mockResolvedValue({ version: 8, id: 'id-new', modelKey: 'm-new' })
    const w = mountPage()
    await flushPromises()

    const vm = w.vm as unknown as { startCreate: () => void; submitForm: () => Promise<void> }
    vm.startCreate()
    await flushPromises()
    // appendToBody 默认 false，弹窗未 teleport，留在组件树内
    expect(w.find('.el-dialog').exists()).toBe(true)
    expect(w.find('.el-dialog').isVisible()).toBe(true)

    // 填表：按 label 定位文本输入；paramsJson 是弹窗内唯一 textarea
    const fillByLabel = async (label: string, value: string) => {
      const item = w.findAll('.el-dialog .el-form-item').find(
        (i) => i.find('.el-form-item__label').text().trim() === label,
      )
      expect(item, `找不到表单项 ${label}`).toBeTruthy()
      await item!.find('input').setValue(value)
    }
    await fillByLabel('modelKey', 'm-new')
    await fillByLabel('displayName', 'Model New')
    await fillByLabel('gatewayModelId', 'gw-new')
    await w.find('.el-dialog textarea').setValue('{"model":"native"}')
    await flushPromises()

    await vm.submitForm()
    await flushPromises()

    expect(createCatalogEntry).toHaveBeenCalledTimes(1)
    expect(createCatalogEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        modelKey: 'm-new',
        displayName: 'Model New',
        gatewayModelId: 'gw-new',
        params: { model: 'native' },
      }),
    )
    // 成功后弹窗关闭（overlay v-show → display:none）
    expect(w.find('.el-dialog').isVisible()).toBe(false)
    expect(listCatalog).toHaveBeenCalledTimes(2) // 初始加载 + 成功后 reload
  })

  it('paramsJson 非法 JSON：submitForm 中止并提示，不调用 createCatalogEntry', async () => {
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({})] })
    const w = mountPage()
    await flushPromises()

    const vm = w.vm as unknown as { startCreate: () => void; submitForm: () => Promise<void> }
    vm.startCreate()
    await flushPromises()
    await w.find('.el-dialog textarea').setValue('not-json')
    await flushPromises()

    await vm.submitForm()
    await flushPromises()

    expect((w.vm as unknown as { actionError: string }).actionError).toContain('params 不是合法 JSON')
    expect(createCatalogEntry).not.toHaveBeenCalled()
    expect(listCatalog).toHaveBeenCalledTimes(1) // 中止，未 reload
  })

  it('上游端点 + 链路状态列：ops 渲染端点与灯色，缺 ops 渲染 —（2026-10-12 增强）', async () => {
    listCatalog.mockResolvedValue({
      version: 7,
      entries: [
        entry({}),
        entry({ id: 'id-2', modelKey: 'm-2' }),
        entry({ id: 'id-3', modelKey: 'm-3' }),
        entry({ id: 'id-4', modelKey: 'm-4', deletedAt: '2026-10-10T00:00:00.000Z' }),
      ],
      ops: {
        'm-1': { upstream: 'agnes_hub', baseUrl: 'https://apihub.agnes-ai.cn/v1', availability: 'unavailable', completed24h: 0, balance40224h: 0 },
        'm-2': { upstream: 'agnes_hub', baseUrl: 'https://apihub.agnes-ai.cn/v1', availability: 'unknown', completed24h: 3, balance40224h: 0 },
      },
    })
    const w = mountPage()
    await flushPromises()
    const text = w.text()
    // 端点列：agnes baseUrl + 上游标注；无 ops 行渲染 —
    expect(text).toContain('https://apihub.agnes-ai.cn/v1')
    expect(text).toContain('上游 agnes_hub')
    // 链路状态：红（探活判定）/绿（流量背书）/灰（无 ops）
    expect(text).toContain('不可用')
    expect(text).toContain('正常')
    expect((w.vm as unknown as { linkOf: (row: { modelKey: string; deletedAt: string | null }) => { level: string; label: string } }).linkOf({ modelKey: 'm-1', deletedAt: null })).toMatchObject({ level: 'red', label: '不可用' })
    expect((w.vm as unknown as { linkOf: (row: { modelKey: string; deletedAt: string | null }) => { level: string; label: string } }).linkOf({ modelKey: 'm-2', deletedAt: null })).toMatchObject({ level: 'green', label: '正常' })
    expect((w.vm as unknown as { linkOf: (row: { modelKey: string; deletedAt: string | null }) => { level: string; label: string } }).linkOf({ modelKey: 'm-3', deletedAt: null })).toMatchObject({ level: 'gray', label: '未知' })
    expect((w.vm as unknown as { linkOf: (row: { modelKey: string; deletedAt: string | null }) => { level: string; label: string } }).linkOf({ modelKey: 'm-4', deletedAt: '2026-10-10T00:00:00.000Z' })).toMatchObject({ level: 'gray', label: '已下架' })
  })

  it('分类筛选：模态/链路状态/生命周期/上游组合过滤（2026-10-12 增强）', async () => {
    listCatalog.mockResolvedValue({
      version: 7,
      entries: [
        entry({}),
        entry({ id: 'id-2', modelKey: 'm-2', gatewayModelId: 'gw-2', modality: 'video' }),
        entry({ id: 'id-3', modelKey: 'm-3', gatewayModelId: 'gw-3', deletedAt: '2026-10-10T00:00:00.000Z' }),
      ],
      ops: {
        'm-1': { upstream: 'agnes_hub', baseUrl: 'https://apihub.agnes-ai.cn/v1', availability: 'unavailable', completed24h: 0, balance40224h: 0 },
        'm-2': { upstream: 'fal', baseUrl: 'https://fal.run/v1', availability: 'available', completed24h: 2, balance40224h: 0 },
      },
    })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as {
      filtered: { modelKey: string }[]
      modalityFilter: string
      linkFilter: string
      lifecycleFilter: string
      upstreamFilter: string
      keyword: string
    }
    expect(vm.filtered.map((e) => e.modelKey)).toEqual(['m-1', 'm-2', 'm-3'])
    vm.modalityFilter = 'video'
    await flushPromises()
    expect(vm.filtered.map((e) => e.modelKey)).toEqual(['m-2'])
    vm.modalityFilter = ''
    vm.linkFilter = 'red'
    await flushPromises()
    expect(vm.filtered.map((e) => e.modelKey)).toEqual(['m-1'])
    vm.linkFilter = ''
    vm.lifecycleFilter = 'off'
    await flushPromises()
    expect(vm.filtered.map((e) => e.modelKey)).toEqual(['m-3'])
    vm.lifecycleFilter = ''
    vm.upstreamFilter = 'fal'
    await flushPromises()
    expect(vm.filtered.map((e) => e.modelKey)).toEqual(['m-2'])
    vm.upstreamFilter = ''
    vm.keyword = 'gw-1'
    await flushPromises()
    // 关键词扩展到 gatewayModelId
    expect(vm.filtered.map((e) => e.modelKey)).toEqual(['m-1'])
  })

  it('筛选态同步 URL query（可分享/收藏）', async () => {
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({})] })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as { modalityFilter: string; lifecycleFilter: string }
    vm.modalityFilter = 'video'
    await flushPromises()
    vm.lifecycleFilter = 'active'
    await flushPromises()
    expect(routeState.replace).toHaveBeenLastCalledWith({ query: expect.objectContaining({ modality: 'video', lifecycle: 'active' }) })
  })

  it('预填上架：?prefill=<modelKey> → 自动打开新增弹窗并预填三标识（missing 去上架闭环）', async () => {
    routeState.query = { prefill: 'agnes-2.5-pro' }
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({})] })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as { dialogVisible: boolean; form: Record<string, unknown> }
    expect(vm.dialogVisible).toBe(true)
    expect(vm.form.modelKey).toBe('agnes-2.5-pro')
    expect(vm.form.gatewayModelId).toBe('agnes-2.5-pro')
  })

  it('在售开关 on→off：确认后调 deleteCatalogEntry（复用下架确认）', async () => {
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({})] })
    deleteCatalogEntry.mockResolvedValue({ version: 8, id: 'id-1', modelKey: 'm-1' })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as { toggleSale: (row: { id: string; modelKey: string; deletedAt: string | null }) => Promise<void> }
    await vm.toggleSale({ id: 'id-1', modelKey: 'm-1', deletedAt: null })
    await flushPromises()
    expect(ElMessageBoxConfirm).toHaveBeenCalled()
    expect(deleteCatalogEntry).toHaveBeenCalledWith('id-1')
  })

  it('在售开关 off→on（软删行）：按既有配置走 POST 恢复上架', async () => {
    listCatalog.mockResolvedValue({ version: 7, entries: [entry({ id: 'id-4', modelKey: 'm-4', deletedAt: '2026-10-10T00:00:00.000Z' })] })
    createCatalogEntry.mockResolvedValue({ version: 8, id: 'id-4', modelKey: 'm-4' })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as {
      toggleSale: (row: { id: string; modelKey: string; deletedAt: string | null }) => Promise<void>
      form: Record<string, unknown>
    }
    await vm.toggleSale({ ...entry({ id: 'id-4', modelKey: 'm-4', deletedAt: '2026-10-10T00:00:00.000Z' }) })
    await flushPromises()
    expect(createCatalogEntry).toHaveBeenCalledWith(expect.objectContaining({ modelKey: 'm-4', gatewayModelId: 'gw-1' }))
  })

  it('批量下架：仅对在售选中项逐条 DELETE，失败项汇总透出、成功项生效', async () => {
    listCatalog.mockResolvedValue({
      version: 7,
      entries: [entry({}), entry({ id: 'id-2', modelKey: 'm-2' }), entry({ id: 'id-3', modelKey: 'm-3', deletedAt: '2026-10-10T00:00:00.000Z' })],
    })
    const { AdminApiError } = await import('@/services/admin-api')
    deleteCatalogEntry.mockImplementation(async (id: string) => {
      if (id === 'id-1') throw new AdminApiError('m-1 是默认模型，禁止下架', 409)
      return { version: 8, id, modelKey: id }
    })
    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as {
      onSelectionChange: (rows: unknown[]) => void
      activeSelectedCount: number
      batchOffboard: () => Promise<void>
      actionError: string
    }
    const rows = [
      { id: 'id-1', modelKey: 'm-1', deletedAt: null },
      { id: 'id-2', modelKey: 'm-2', deletedAt: null },
      { id: 'id-3', modelKey: 'm-3', deletedAt: '2026-10-10T00:00:00.000Z' },
    ]
    vm.onSelectionChange(rows)
    expect(vm.activeSelectedCount).toBe(2)
    await vm.batchOffboard()
    await flushPromises()
    expect(ElMessageBoxConfirm).toHaveBeenCalledTimes(1)
    expect(deleteCatalogEntry).toHaveBeenCalledTimes(2)
    expect(deleteCatalogEntry).toHaveBeenCalledWith('id-1')
    expect(deleteCatalogEntry).toHaveBeenCalledWith('id-2')
    expect(vm.actionError).toContain('m-1 是默认模型，禁止下架')
  })

  it('isDefault 条目渲染「默认」徽标 + 非默认渲染占位（model-ops Task 1 数据化）', async () => {
    listCatalog.mockResolvedValue({
      version: 7,
      entries: [entry({ id: 'id-1', modelKey: 'm-1', isDefault: true }), entry({ id: 'id-2', modelKey: 'm-2' })],
    })
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('默认')
  })

  it('下架默认模型 409 带 alternatives → 渲染切换面板，点候选先切默认再下架（spec P0-4）', async () => {
    const { AdminApiError } = await import('@/services/admin-api')
    listCatalog.mockResolvedValue({
      version: 7,
      entries: [
        entry({ id: 'id-1', modelKey: 'm-1', modality: 'audio', isDefault: true }),
        entry({ id: 'id-2', modelKey: 'm-2', modality: 'audio' }),
      ],
    })
    const alternatives = [{ modelKey: 'm-2', displayName: 'Model Two', availability: 'unknown' as const }]
    deleteCatalogEntry
      .mockRejectedValueOnce(new AdminApiError('m-1 是 audio 模态的当前默认模型，禁止直接下架', 409, { alternatives }))
      .mockResolvedValueOnce({ version: 8, id: 'id-1', modelKey: 'm-1' })
    setDefault.mockResolvedValue({
      version: 8,
      modality: 'audio',
      previousDefault: 'm-1',
      default: { modelKey: 'm-2', displayName: 'Model Two', isDefault: true },
    })

    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as {
      toggleSale: (row: { id: string; modelKey: string; modality: string; deletedAt: string | null }) => Promise<void>
      defaultBlocker: { modelKey: string; modality: string; alternatives: { modelKey: string }[] } | null
      switchDefaultAndDelist: (alt: { modelKey: string; displayName: string; availability: string }) => Promise<void>
    }
    await vm.toggleSale({ id: 'id-1', modelKey: 'm-1', modality: 'audio', deletedAt: null })
    await flushPromises()

    // 409 被转化为切换面板（而非裸文案），含候选按钮
    expect(vm.defaultBlocker).toMatchObject({ modelKey: 'm-1', modality: 'audio' })
    expect(w.text()).toContain('切换到 m-2 再下架')
    expect(listCatalog).toHaveBeenCalledTimes(1) // 未下架，未 reload

    // 点候选 → 先切默认（modality+modelKey），再 DELETE 原条目
    await vm.switchDefaultAndDelist(alternatives[0])
    await flushPromises()
    expect(setDefault).toHaveBeenCalledWith('audio', 'm-2')
    expect(deleteCatalogEntry).toHaveBeenLastCalledWith('id-1')
    expect(vm.defaultBlocker).toBeNull()
    expect(listCatalog).toHaveBeenCalledTimes(2)
  })

  it('切默认自身 409（目标 unavailable）→ 保留面板并透出原因，不改选则不下架', async () => {
    const { AdminApiError } = await import('@/services/admin-api')
    listCatalog.mockResolvedValue({
      version: 7,
      entries: [
        entry({ id: 'id-1', modelKey: 'm-1', modality: 'audio', isDefault: true }),
        entry({ id: 'id-2', modelKey: 'm-2', modality: 'audio' }),
      ],
    })
    deleteCatalogEntry.mockRejectedValue(
      new AdminApiError('m-1 是 audio 模态的当前默认模型，禁止直接下架', 409, {
        alternatives: [{ modelKey: 'm-2', displayName: 'Model Two', availability: 'unknown' as const }],
      }),
    )
    setDefault.mockRejectedValue(new AdminApiError('m-2 探活不可用（unavailable），禁止设为默认', 409))

    const w = mountPage()
    await flushPromises()
    const vm = w.vm as unknown as {
      toggleSale: (row: { id: string; modelKey: string; modality: string; deletedAt: string | null }) => Promise<void>
      defaultBlocker: { modelKey: string } | null
      switchDefaultAndDelist: (alt: { modelKey: string; displayName: string; availability: string }) => Promise<void>
    }
    await vm.toggleSale({ id: 'id-1', modelKey: 'm-1', modality: 'audio', deletedAt: null })
    await flushPromises()
    await vm.switchDefaultAndDelist({ modelKey: 'm-2', displayName: 'Model Two', availability: 'unknown' })
    await flushPromises()

    expect(setDefault).toHaveBeenCalledWith('audio', 'm-2')
    expect((w.vm as unknown as { actionError: string }).actionError).toContain('禁止设为默认')
    // 面板仍在，可改选其它候选
    expect(vm.defaultBlocker).not.toBeNull()
    expect(deleteCatalogEntry).toHaveBeenCalledTimes(1) // 仅首次下架被拦，未继续删
  })
})
