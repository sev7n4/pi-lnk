import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeStatusBar from './MobileNodeStatusBar.vue'
import { useProviderBootstrap } from '@/composables/useProviderBootstrap'
import { __resetAutoApproveForTest } from '@/composables/useAutoApproveGeneration'

/**
 * 移动端壳层状态栏 · 授权态**不得**再出现（2026-11-23 UI 迭代的守卫测试）。
 *
 * ⭐ 为什么从「行为测试」改成「守卫测试」：
 * 原契约是「已授权 ⇒ 状态带内出现徽标 + 收回授权」。2026-11-23 UI 迭代把授权态
 * 从状态带**迁出**（迁到移动 composer 裸条工具行，与 PC 同一枚图标），
 * 于是本文件从「断言徽标存在」翻转为「断言徽标不存在」——
 * **防止有人日后把通栏文字徽标塞回状态带**（那正是用户投诉的「对话页被污染」同款问题）。
 *
 * 迁出的三条理由（迁出后一并消失的妥协条件）：
 * ① 授权状态不是「节点状态」，放节点状态带本就错位；
 * ② 状态带只在「生成中 / 待确认」时出现 ⇒ 空闲时看不到授权态、也点不到撤回，
 *    而「随时能自己踩刹车」是硬要求；
 * ③ 原规格「徽标仅在状态带可见时出现，否则破坏 MobileSaveStatus 互斥」的妥协条件随之消失。
 */

const { updatePreferences, success, error, message } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(() => ({ close: vi.fn() })),
}))

vi.mock('@/services/provider-api', () => ({
  providerApi: { updatePreferences },
}))

vi.mock('element-plus', () => {
  const ElMessage = message as unknown as {
    (opts: unknown): { close: () => void }
    success: typeof success
    error: typeof error
  }
  ElMessage.success = success
  ElMessage.error = error
  return { ElMessage }
})

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

describe('MobileNodeStatusBar — 授权态已迁出状态带（2026-11-23 守卫）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetAutoApproveForTest()
    const { bootstrap } = useProviderBootstrap()
    bootstrap.value = null
  })

  it('已授权 + 有任务 ⇒ 状态带内不再出现授权徽标（迁至 composer 工具行）', () => {
    setPreferences('auto')
    const w = mount(MobileNodeStatusBar, { props: { generatingCount: 1, pendingNodes: [] } })
    expect(w.find('[data-testid="mobile-node-status-auto"]').exists()).toBe(false)
    expect(w.find('[data-testid="mobile-node-status-auto-revoke"]').exists()).toBe(false)
    expect(w.text()).not.toContain('已授权自动生成')
    expect(w.text()).not.toContain('收回授权')
    w.unmount()
  })

  it('已授权 + 有待确认节点 ⇒ 同样不承载授权态（决策面不混装状态提示）', () => {
    setPreferences('auto')
    const w = mount(MobileNodeStatusBar, {
      props: {
        generatingCount: 0,
        pendingNodes: [
          {
            id: 'n1',
            type: 'image',
            label: '产品主图',
            nodeId: 'n1',
            createdAt: Date.now(),
          },
        ] as never,
      },
    })
    expect(w.find('[data-testid="mobile-node-status-auto"]').exists()).toBe(false)
    w.unmount()
  })

  it('未授权 ⇒ 同样不出现（守卫不随偏好状态漂移）', () => {
    setPreferences('manual')
    const w = mount(MobileNodeStatusBar, { props: { generatingCount: 1, pendingNodes: [] } })
    expect(w.find('[data-testid="mobile-node-status-auto"]').exists()).toBe(false)
    w.unmount()
  })

  it('无任务时状态带整体不渲染（不因授权态单独占位）', () => {
    setPreferences('auto')
    const w = mount(MobileNodeStatusBar, { props: { generatingCount: 0, pendingNodes: [] } })
    expect(w.find('.mobile-node-status-bar').exists()).toBe(false)
    w.unmount()
  })
})
