import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICESTUDIO_MODEL_ENTRY, type StudioModelEntry, type StudioVoiceOption } from '@lnkpi/shared'
import {
  parseVoiceStudioVoicesResponse,
  mergeVoiceStudioVoices,
  refreshVoiceStudioVoices,
  voiceStudioRuntimeVoices,
  __resetVoiceStudioRuntimeForTests,
} from './voice-studio-runtime'

/**
 * VoiceStudio 运行时音色同步单测（P1 §4.1，纯单测无 DB）：
 * - VS voices 响应防御式解析（id/voice_id 双字段、畸形返回 null 保旧值）；
 * - merge 只动 voicestudio-http 条目（dock 下拉与生成侧 voice 校验同源）；
 * - 拉取失败/停机保旧值不阻塞（下拉回退条目静态保底表）。
 */

const VS_ENTRY = VOICESTUDIO_MODEL_ENTRY

function otherEntry(): StudioModelEntry {
  return STUDIO_SEED_AUDIO
}
const STUDIO_SEED_AUDIO: StudioModelEntry = {
  modelKey: 'seed-audio-1.0',
  displayName: 'Seed Audio 1.0',
  gatewayModelId: 'seed-audio-1.0',
  modality: 'audio',
  audioKind: 'voice',
  providerBinding: 'gateway-openai-compat',
  params: { model: 'native', voice: 'native', speed: 'native' },
  voices: [{ id: 'seed-female-1', label: '女声 1' }],
}

describe('parseVoiceStudioVoicesResponse（防御式解析）', () => {
  it('标准响应（id + voice_id 双字段、name 缺省回落 id）', () => {
    const out = parseVoiceStudioVoicesResponse({
      voices: [
        { voice_id: 'default', name: 'Default', id: 'default' },
        { voice_id: 'lnk-abc123', name: '主角·林晚' },
        { id: 'no-name' },
        { name: 'no-id' }, // 缺 id：跳过
        'junk', // 非对象：跳过
      ],
      engines: [{ id: 'omnivoice' }],
    })
    expect(out).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'lnk-abc123', label: '主角·林晚' },
      { id: 'no-name', label: 'no-name' },
    ])
  })

  it('畸形响应一律 null（保旧值判据）：非对象 / 缺 voices / voices 非数组 / 全空', () => {
    expect(parseVoiceStudioVoicesResponse(null)).toBeNull()
    expect(parseVoiceStudioVoicesResponse('junk')).toBeNull()
    expect(parseVoiceStudioVoicesResponse({})).toBeNull()
    expect(parseVoiceStudioVoicesResponse({ voices: 'x' })).toBeNull()
    expect(parseVoiceStudioVoicesResponse({ voices: [] })).toBeNull()
    // VS 恒返回 OpenAI 标准别名 + default —— 空清单=畸形（防半残响应清空下拉）
    expect(parseVoiceStudioVoicesResponse({ voices: [{ name: 'no-id-here' }] })).toBeNull()
  })
})

describe('refreshVoiceStudioVoices + voiceStudioRuntimeVoices（TTL 惰性 + 失败保旧值）', () => {
  const savedEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  function setEnv(apiKey?: string, baseUrl?: string): void {
    delete process.env.OMNIVOICE_API_KEY
    delete process.env.OMNIVOICE_BASE_URL
    if (apiKey) process.env.OMNIVOICE_API_KEY = apiKey
    if (baseUrl) process.env.OMNIVOICE_BASE_URL = baseUrl
  }

  beforeEach(() => {
    __resetVoiceStudioRuntimeForTests()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    process.env = { ...savedEnv }
    vi.unstubAllGlobals()
  })

  it('env 未配置：不发起任何请求（no-op）', async () => {
    setEnv()
    await refreshVoiceStudioVoices()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(voiceStudioRuntimeVoices()).toBeNull()
  })

  it('拉取成功：缓存运行时清单（VS profile 音色进下拉）', async () => {
    setEnv('vs-key', 'http://172.17.0.1:3900/')
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        voices: [
          { voice_id: 'default', name: 'Default', id: 'default' },
          { voice_id: 'lnk-u1-a', name: '旁白·沉稳', type: 'profile' },
        ],
      }),
    })
    await refreshVoiceStudioVoices()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://172.17.0.1:3900/v1/audio/voices')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer vs-key' })
    expect(voiceStudioRuntimeVoices()).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'lnk-u1-a', label: '旁白·沉稳' },
    ])
  })

  it('非 2xx / 网络异常：保旧值不炸（失败不当故障，下拉回退保底表）', async () => {
    setEnv('vs-key', 'http://172.17.0.1:3900')
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ voices: [{ id: 'a', name: 'A' }] }) })
    await refreshVoiceStudioVoices()
    expect(voiceStudioRuntimeVoices()).toEqual([{ id: 'a', label: 'A' }])

    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 })
    await expect(refreshVoiceStudioVoices()).resolves.toBeUndefined()
    expect(voiceStudioRuntimeVoices()).toEqual([{ id: 'a', label: 'A' }])

    fetchMock.mockRejectedValueOnce(new Error('upstream timeout after 5000ms'))
    await expect(refreshVoiceStudioVoices()).resolves.toBeUndefined()
    expect(voiceStudioRuntimeVoices()).toEqual([{ id: 'a', label: 'A' }])
  })

  it('畸形成功响应（空 voices）：不覆盖旧缓存', async () => {
    setEnv('vs-key', 'http://172.17.0.1:3900')
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ voices: [{ id: 'a', name: 'A' }] }) })
    await refreshVoiceStudioVoices()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ voices: [] }) })
    await refreshVoiceStudioVoices()
    expect(voiceStudioRuntimeVoices()).toEqual([{ id: 'a', label: 'A' }])
  })
})

describe('mergeVoiceStudioVoices（只动 voicestudio-http 条目，其余引用不变）', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    __resetVoiceStudioRuntimeForTests()
    process.env = { ...savedEnv }
    process.env.OMNIVOICE_API_KEY = 'vs-key'
    process.env.OMNIVOICE_BASE_URL = 'http://172.17.0.1:3900'
  })

  afterEach(() => {
    process.env = { ...savedEnv }
    vi.unstubAllGlobals()
  })

  it('有运行时缓存：VS 条目 voices 覆盖为运行时清单；非 VS 条目原样（同引用）', async () => {
    // ⚠️ mock 是 VS 响应形状（`name` 字段），不是 StudioVoiceOption（`label`）
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ voices: [{ id: 'default', name: 'Default' }, { id: 'lnk-u1-a', name: '旁白·沉稳' }] }),
    }))
    await refreshVoiceStudioVoices()
    const runtime: StudioVoiceOption[] = [
      { id: 'default', label: 'Default' },
      { id: 'lnk-u1-a', label: '旁白·沉稳' },
    ]

    const rows = [VS_ENTRY, otherEntry()]
    const merged = mergeVoiceStudioVoices(rows)
    const vsMerged = merged.find((e) => e.modelKey === 'voicestudio-local')
    expect(vsMerged?.voices).toEqual(runtime)
    // 非 VS 条目引用原样（零拷贝路径，防目录对象被意外复制引发性能回归）
    expect(merged.find((e) => e.modelKey === 'seed-audio-1.0')).toBe(rows[1])
    // 原 VS 条目不被就地修改（不可变合并）
    expect(VS_ENTRY.voices).not.toEqual(runtime)
  })

  it('无运行时缓存（未拉取/失败）：全部原样返回（保底表生效，不阻塞）', () => {
    vi.stubGlobal('fetch', vi.fn()) // 无人 await 刷新 ⇒ 缓存仍空
    const rows = [VS_ENTRY, otherEntry()]
    expect(mergeVoiceStudioVoices(rows)).toBe(rows)
  })
})
