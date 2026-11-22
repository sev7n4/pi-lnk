import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeStatusBar from './MobileNodeStatusBar.vue'
import { useProviderBootstrap } from '@/composables/useProviderBootstrap'
import { __resetAutoApproveForTest } from '@/composables/useAutoApproveGeneration'

/**
 * 移动端状态带 · 授权自动生成徽标（规格 2026-11-22-generation-auto-approve-gate-design §3.4/§4.2）。
 *
 * 契约：
 * 1. 徽标**并入既有状态带**（不新增第三条状态带；无任务时状态带整体不渲染）；
 * 2. 已授权时出现「已授权自动生成」+ 一键「收回授权」；
 * 3. 收回授权写账号级偏好 manual（服务端 SSOT）；
 * 4. 未授权时不渲染徽标。
 */

const { updatePreferences, success } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/services/provider-api', () => ({
  providerApi: { updatePreferences },
}))

vi.mock('element-plus', () => ({
  ElMessage: { success, error: vi.fn(), info: vi.fn() },
}))

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

describe('MobileNodeStatusBar — 已授权自动生成徽标（2026-11-22 规格 §3.4）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAutoApproveForTest()
    const { bootstrap } = useProviderBootstrap()
    bootstrap.value = null
  })

  it('未授权 ⇒ 不渲染徽标', () => {
    setPreferences('manual')
    const w = mount(MobileNodeStatusBar, { props: { generatingCount: 1, pendingNodes: [] } })
    expect(w.find('[data-testid="mobile-node-status-auto"]').exists()).toBe(false)
    w.unmount()
  })

  it('已授权 ⇒ 徽标与「收回授权」出现在既有状态带内（不新增第三条带）', () => {
    setPreferences('auto')
    const w = mount(MobileNodeStatusBar, { props: { generatingCount: 1, pendingNodes: [] } })
    const badge = w.find('[data-testid="mobile-node-status-auto"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('已授权自动生成')
    // 徽标在状态带容器内
    expect(w.find('.mobile-node-status-bar [data-testid="mobile-node-status-auto"]').exists()).toBe(
      true,
    )
    w.unmount()
  })

  it('点「收回授权」⇒ 写账号级偏好 manual', async () => {
    setPreferences('auto')
    updatePreferences.mockResolvedValue({ ...basePreferences, autoApproveGenerations: 'manual' })
    const w = mount(MobileNodeStatusBar, { props: { generatingCount: 1, pendingNodes: [] } })

    await w.find('[data-testid="mobile-node-status-auto-revoke"]').trigger('click')

    expect(updatePreferences).toHaveBeenCalledWith({ autoApproveGenerations: 'manual' })
    w.unmount()
  })

  it('无任务时状态带整体不渲染（徽标不单独占位）', () => {
    setPreferences('auto')
    const w = mount(MobileNodeStatusBar, { props: { generatingCount: 0, pendingNodes: [] } })
    expect(w.find('.mobile-node-status-bar').exists()).toBe(false)
    w.unmount()
  })
})
