import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useAutoApproveGeneration, __resetAutoApproveForTest } from './useAutoApproveGeneration'
import { useProviderBootstrap } from './useProviderBootstrap'

/**
 * 授权自动生成（规格 2026-11-22-generation-auto-approve-gate-design §3.2/§4）：
 * 账号级偏好的读写薄接线——服务端是 SSOT，前端不缓存本地态。
 */

const { updatePreferences, success, error } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@/services/provider-api', () => ({
  providerApi: { updatePreferences },
}))

vi.mock('element-plus', () => ({
  ElMessage: { success, error },
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

describe('useAutoApproveGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const { bootstrap } = useProviderBootstrap()
    bootstrap.value = null
    __resetAutoApproveForTest()
  })

  it('未加载偏好时按未授权处理（不猜授权态）', () => {
    const { authorized } = useAutoApproveGeneration()
    expect(authorized.value).toBe(false)
  })

  it('服务端返回 auto ⇒ 已授权', () => {
    const { bootstrap } = useProviderBootstrap()
    bootstrap.value = {
      platformChannel: null as never,
      channels: [],
      preferences: { ...basePreferences, autoApproveGenerations: 'auto' },
      webdav: null as never,
      catalog: [],
    }
    const { authorized } = useAutoApproveGeneration()
    expect(authorized.value).toBe(true)
  })

  it('授权 ⇒ 写 auto 并回写本地 bootstrap（单一真源，不缓存 localStorage）', async () => {
    updatePreferences.mockResolvedValue({ ...basePreferences, autoApproveGenerations: 'auto' })
    const { setAuthorized, authorized } = useAutoApproveGeneration()

    const ok = await setAuthorized(true)
    expect(ok).toBe(true)
    expect(updatePreferences).toHaveBeenCalledWith({ autoApproveGenerations: 'auto' })
    expect(authorized.value).toBe(true)
    expect(success).toHaveBeenCalled()
  })

  it('收回授权 ⇒ 写 manual 并回写本地 bootstrap', async () => {
    updatePreferences.mockResolvedValue({ ...basePreferences, autoApproveGenerations: 'manual' })
    const { setAuthorized, authorized } = useAutoApproveGeneration()

    const ok = await setAuthorized(false)
    expect(ok).toBe(true)
    expect(updatePreferences).toHaveBeenCalledWith({ autoApproveGenerations: 'manual' })
    expect(authorized.value).toBe(false)
  })

  it('写失败 ⇒ 返回 false 并报错（不静默假装成功）', async () => {
    updatePreferences.mockRejectedValue(new Error('网络异常'))
    const { setAuthorized } = useAutoApproveGeneration()

    const ok = await setAuthorized(true)
    expect(ok).toBe(false)
    expect(error).toHaveBeenCalled()
  })

  it('silent 模式不弹 toast（调用方自行呈现）', async () => {
    updatePreferences.mockResolvedValue({ ...basePreferences, autoApproveGenerations: 'auto' })
    const { setAuthorized } = useAutoApproveGeneration()

    await setAuthorized(true, { silent: true, successMessage: '下次生效' })
    expect(success).not.toHaveBeenCalled()
  })
})
