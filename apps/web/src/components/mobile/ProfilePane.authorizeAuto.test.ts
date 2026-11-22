import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import ProfilePane from './ProfilePane.vue'
import { useProviderBootstrap } from '@/composables/useProviderBootstrap'
import { __resetAutoApproveForTest } from '@/composables/useAutoApproveGeneration'

/**
 * 移动端「我的 → 设置」里的授权自动生成开关（规格 2026-11-22-generation-auto-approve-gate-design §4）。
 *
 * 契约：
 * 1. 设置二级卡内出现开关（role=switch + aria-checked），紧邻触感反馈开关；
 * 2. 账号级偏好（服务端 SSOT），不是 localStorage 偏好；
 * 3. 点击写账号级偏好并即时反映到 aria-checked。
 */

const { updatePreferences, success } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/services/provider-api', () => ({
  providerApi: { updatePreferences },
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('element-plus', () => ({
  ElMessage: { info: vi.fn(), error: vi.fn(), success },
}))

const stubs = {
  ThemeToggle: { template: '<div class="theme-toggle-stub" />' },
  TopupModal: { template: '<div />' },
  BrandPatternAvatar: { template: '<div class="avatar-stub" />' },
}

const basePreferences = {
  selectableImageModels: [],
  selectableVideoModels: [],
  selectableTextModels: [],
  selectableAudioModels: [],
  defaultImageModel: '',
  defaultVideoModel: '',
  defaultTextModel: '',
  defaultAudioModel: '',
  canvasImageCount: 3,
  defaultImageAspect: '16:9',
  defaultImageResolution: '1K',
  defaultVideoAspect: '16:9',
  defaultVideoDuration: 5,
  defaultVideoResolution: '720p',
  defaultVideoCrop: 'none',
  audioVoice: 'female-shaonv',
  audioFormat: 'mp3',
  audioSpeed: 1,
  audioInstructions: null,
  systemPrompt: null,
  autoApproveGenerations: 'manual' as 'manual' | 'auto',
}

function setPreferences(autoApproveGenerations: 'manual' | 'auto') {
  const { bootstrap } = useProviderBootstrap()
  bootstrap.value = {
    platformChannel: null as never,
    channels: [],
    preferences: { ...basePreferences, autoApproveGenerations },
    webdav: null as never,
    catalog: [],
  }
}

async function mountPane() {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.token = 'test-token'
  auth.user = { id: 'u_1', nickname: '小墨' } as never
  const wrapper = mount(ProfilePane, { global: { stubs } })
  // 展开「设置」二级卡
  const settingsRow = wrapper.findAll('button.row-item').find((b) => b.text().includes('设置'))
  await settingsRow!.trigger('click')
  await flushPromises()
  return wrapper
}

describe('ProfilePane — 授权自动生成开关（2026-11-22 规格 §4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAutoApproveForTest()
    const { bootstrap } = useProviderBootstrap()
    bootstrap.value = null
  })

  it('设置二级卡内出现开关，未授权时 aria-checked=false', async () => {
    setPreferences('manual')
    const w = await mountPane()
    const sw = w.find('[data-testid="auto-approve-switch"]')
    expect(sw.exists()).toBe(true)
    expect(sw.attributes('role')).toBe('switch')
    expect(sw.attributes('aria-checked')).toBe('false')
    w.unmount()
  })

  it('已授权时 aria-checked=true（读账号级偏好，不是 localStorage）', async () => {
    setPreferences('auto')
    const w = await mountPane()
    const sw = w.find('[data-testid="auto-approve-switch"]')
    expect(sw.attributes('aria-checked')).toBe('true')
    w.unmount()
  })

  it('点击 ⇒ 写账号级偏好 auto 并即时反映到开关', async () => {
    setPreferences('manual')
    updatePreferences.mockResolvedValue({ ...basePreferences, autoApproveGenerations: 'auto' })
    const w = await mountPane()

    await w.find('[data-testid="auto-approve-switch"]').trigger('click')
    await flushPromises()

    expect(updatePreferences).toHaveBeenCalledWith({ autoApproveGenerations: 'auto' })
    expect(w.find('[data-testid="auto-approve-switch"]').attributes('aria-checked')).toBe('true')
    w.unmount()
  })
})
