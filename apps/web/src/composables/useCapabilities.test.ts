import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listModels } from '@lnkpi/shared'
import { useCapabilities } from './useCapabilities'
import { capabilitiesApi } from '@/services/capabilities-api'

vi.mock('@/services/capabilities-api', () => ({
  capabilitiesApi: { list: vi.fn() },
}))

function audioModel() {
  return { id: 'minimax-speech-2.8-hd', name: 'MiniMax Speech 2.8 HD' }
}

describe('useCapabilities audio 能力位', () => {
  beforeEach(() => {
    vi.mocked(capabilitiesApi.list).mockReset()
    // useCapabilities 内部有模块级 `loaded` 标志，一旦被某个用例置 true，
    // 后续 reload() 会直接 return —— 用例之间必须能各自触发一次真实请求。
    vi.resetModules()
  })

  it('exposes an audio list from the catalog even before/without load()', () => {
    // 回归锁：GenerationType 曾经只有 text|image|video，audio 维度整个缺失
    const { modelsFor } = useCapabilities()
    expect(modelsFor('audio' as never).map((m) => m.id)).toEqual(
      listModels('audio').map((m) => m.modelKey),
    )
  })

  it('is non-empty for every modality by default', () => {
    const { modelsFor } = useCapabilities()
    for (const t of ['text', 'image', 'video', 'audio'] as never[]) {
      expect(modelsFor(t).length).toBeGreaterThan(0)
    }
  })

  it('keeps catalog defaults when the api throws, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(capabilitiesApi.list).mockRejectedValue(new Error('404'))
    const { modelsFor, reload } = useCapabilities()

    await reload()

    expect(modelsFor('video' as never).length).toBeGreaterThan(0)
    expect(modelsFor('audio' as never).length).toBeGreaterThan(0)
    // 静默 catch 会让「后端无此路由」完全无声（审计 §2.5）。
    // ⚠️ 只数我们自己的那条：Vue 在无组件实例时也会 console.warn(onMounted…)，那是噪音。
    const ours = warn.mock.calls.filter((c) => String(c[0]).includes('[capabilities]'))
    expect(ours).toHaveLength(1)
    expect(String(ours[0]?.[0])).toMatch(/capabilities\/list unavailable/)
    expect(String(ours[0]?.[1])).toMatch(/404/)
    warn.mockRestore()
  })

  it('accepts audio from the api response', async () => {
    vi.mocked(capabilitiesApi.list).mockResolvedValue({
      data: {
        data: {
          text: [], image: [], video: [],
          audio: [audioModel()],
          stsDirectUpload: false,
        },
      },
    } as never)
    const { modelsFor, reload } = useCapabilities()
    await reload()
    expect(modelsFor('audio' as never)).toEqual([audioModel()])
  })
})
