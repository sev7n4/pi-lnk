import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PublishNeoTVDialog from './PublishNeoTVDialog.vue'

const { publishMock, authState, apiGet } = vi.hoisted(() => ({
  publishMock: vi.fn(),
  // 候选主成片节点来自 GET /sessions/:id 的 canvasData —— 不给节点就无法提交
  apiGet: vi.fn(),
  authState: { userId: 'u_1' as string | undefined },
}))

vi.mock('@/services/works-api', () => ({
  worksApi: { publish: (...args: unknown[]) => publishMock(...args) },
}))

vi.mock('@/services/api', () => ({ api: { get: apiGet, post: vi.fn() } }))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    get user() {
      return authState.userId ? { id: authState.userId } : null
    },
  }),
}))

vi.mock('@/stores/canvasEditor', () => ({
  useCanvasEditorStore: () => ({
    openMediaPreview: vi.fn(),
    closeMediaPreview: vi.fn(),
    canvasData: { nodes: [], edges: [] },
  }),
}))

const stubs = {
  ElDialog: {
    template: '<div v-if="modelValue"><slot /></div>',
    props: ['modelValue'],
  },
  ElSelect: { template: '<div><slot /></div>' },
  ElOption: { template: '<div />' },
  ElRadioGroup: { template: '<div><slot /></div>' },
  ElRadio: { template: '<label><slot /></label>' },
  ElInput: { template: '<input />' },
  ElButton: { template: '<button><slot /></button>' },
  MediaPreviewOverlay: true,
  CanvasLocateButton: true,
  RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
}

async function mountDialog() {
  setActivePinia(createPinia())
  apiGet.mockResolvedValue({
    data: {
      data: {
        canvasData: {
          nodes: [{ id: 'n1', type: 'image', data: { url: 'https://cdn/a.png' } }],
          edges: [],
        },
      },
    },
  })
  const wrapper = mount(PublishNeoTVDialog, {
    props: {
      // 组件用 watch(() => props.modelValue) 触发节点加载（非 immediate）⇒
      // 必须先以关闭态挂载再置true，才能走上真实打开路径
      modelValue: false,
      sessionId: 's_1',
      sessions: [{ id: 's_1', title: '我的画布' }],
      defaultTitle: '星海回响',
    },
    global: { stubs },
  })
  await wrapper.setProps({ modelValue: true })
  await flushPromises()
  return wrapper
}

/** 走handlePublish 的成功路径：直接提交（首个候选节点由 loadPrimaryNodes 自动选中） */
async function publishSuccessfully(wrapper: Awaited<ReturnType<typeof mountDialog>>) {
  publishMock.mockResolvedValue({ data: { data: { id: 'w_1' } } })
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

describe('PublishNeoTVDialog 发布成功引导（P2 Task 3）', () => {
  beforeEach(() => {
    publishMock.mockReset()
    authState.userId = 'u_1'
  })

  it('发布成功后给出「查看我的主页」入口，指向本人 creator 页', async () => {
    const wrapper = await mountDialog()
    await publishSuccessfully(wrapper)
    const link = wrapper.find('[data-testid="publish-view-homepage"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('/creator/u_1')
  })

  it('成功文案无 emoji（设计体系禁 emoji 图标）', async () => {
    const wrapper = await mountDialog()
    await publishSuccessfully(wrapper)
    expect(wrapper.text()).toContain('发布成功')
    expect(wrapper.text()).not.toContain('🎉')
  })

  it('未登录态（无 user.id）不渲染主页链接', async () => {
    authState.userId = undefined
    const wrapper = await mountDialog()
    await publishSuccessfully(wrapper)
    expect(wrapper.find('[data-testid="publish-view-homepage"]').exists()).toBe(false)
  })

  it('成功态仍 emit published（父组件刷新逻辑不受影响）', async () => {
    const wrapper = await mountDialog()
    await publishSuccessfully(wrapper)
    expect(wrapper.emitted('published')).toHaveLength(1)
  })
})
