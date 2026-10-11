import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import AdminModelsPage from './AdminModelsPage.vue'

const { ElMessageBoxConfirm } = vi.hoisted(() => ({ ElMessageBoxConfirm: vi.fn(async () => 'confirm') }))

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

const { listCatalog, createCatalogEntry, deleteCatalogEntry } = vi.hoisted(() => ({
  listCatalog: vi.fn(),
  createCatalogEntry: vi.fn(),
  deleteCatalogEntry: vi.fn(),
}))

vi.mock('@/services/admin-api', () => ({
  adminApi: {
    listCatalog: (...a: unknown[]) => listCatalog(...a),
    createCatalogEntry: (...a: unknown[]) => createCatalogEntry(...a),
    updateCatalogEntry: vi.fn(),
    deleteCatalogEntry: (...a: unknown[]) => deleteCatalogEntry(...a),
  },
  AdminApiError: class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
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
})
