import { describe, expect, it, afterAll } from 'vitest'
import { encodeChannelModel, getModelEntry, listModels } from '@lnkpi/shared'
import type { StudioModelEntry } from '@lnkpi/shared'
import {
  __resetStudioCatalogForTests,
  setStudioCatalogEntries,
} from './studioModels'
import {
  AUDIO_VOICE_OPTIONS,
  DEFAULT_AUDIO_VOICE,
  AUDIO_KIND_OPTIONS,
  audioKindOfModelValue,
  defaultVoiceForKind,
  hasDesignContent,
  modelsForAudioKind,
  pickSelectableModelForKind,
  resolveKindSwitchModel,
} from './dockAudio'

// 回归锁：DEFAULT_AUDIO_VOICE='female-shaonv'（catalog minimax-speech-2.8-hd 的
// 默认音色），但 AUDIO_VOICE_OPTIONS 列的是 female-1 / male-1 / narrator ——
// **与 catalog 的 voices 完全不重叠**。用户在 Dock 音频面板看到的是三个跟后端
// 对不上的音色名，而实际下发的默认值根本不在列表里。
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.5
describe('AUDIO_VOICE_OPTIONS 与 catalog 对齐', () => {
  it('contains the default voice', () => {
    expect(AUDIO_VOICE_OPTIONS.some((v) => v.id === DEFAULT_AUDIO_VOICE)).toBe(true)
  })

  it('every option id exists in the audio catalog voices', () => {
    const catalogVoiceIds = new Set(
      listModels('audio').flatMap((m) => (m.voices ?? []).map((v) => v.id)),
    )
    expect(catalogVoiceIds.size).toBeGreaterThan(0)
    for (const opt of AUDIO_VOICE_OPTIONS) {
      expect(
        catalogVoiceIds.has(opt.id),
        `音色 ${opt.id}（${opt.label}）不在 audio catalog 里：${[...catalogVoiceIds].join(', ')}`,
      ).toBe(true)
    }
  })

  it('every option label matches the catalog label (no duplicated source of truth)', () => {
    const catalogLabels = new Map<string, string>()
    for (const m of listModels('audio')) {
      for (const v of m.voices ?? []) catalogLabels.set(v.id, v.label)
    }
    for (const opt of AUDIO_VOICE_OPTIONS) {
      expect(opt.label).toBe(catalogLabels.get(opt.id))
    }
  })

  it('the default voice is what the catalog itself declares as default', () => {
    const entry = getModelEntry('minimax-speech-2.8-hd')
    expect(entry?.defaults?.voice).toBe(DEFAULT_AUDIO_VOICE)
  })
})

describe('音频三分类 kind helpers', () => {
  it('三分类固定顺序 voice/design/music（UI 顺序即此）', () => {
    expect(AUDIO_KIND_OPTIONS.map((o) => o.value)).toEqual(['voice', 'design', 'music'])
  })

  it('模型列表按 kind 过滤（选音乐不会列出 TTS 模型）', () => {
    expect(modelsForAudioKind('music').map((m) => m.modelKey)).toEqual([
      'stepaudio-3-music-preview',
    ])
    expect(
      modelsForAudioKind('voice').some((m) => m.modelKey === 'stepaudio-3-music-preview'),
    ).toBe(false)
  })

  it('缺省 kind 视作 voice 且默认模型不变', () => {
    expect(defaultVoiceForKind(undefined)).toBe('minimax-speech-2.8-hd')
  })

  // 🔴 防错锁：切分类时前端把模型换成该分类首选。若这里回退成 voice 的 TTS 模型，
  // 「音乐 + TTS 模型」会被服务端 `assertAudioKindMatchesModel` 显式 400 拒掉。
  it('每个分类的首选模型必须属于该分类（否则生成必撞 400）', () => {
    for (const kind of AUDIO_KIND_OPTIONS.map((o) => o.value)) {
      const modelKey = defaultVoiceForKind(kind)
      expect(
        modelsForAudioKind(kind).some((m) => m.modelKey === modelKey),
        `${kind} 的首选模型 ${modelKey} 不在 ${kind} 分类里`,
      ).toBe(true)
    }
  })
})

/**
 * 🔴 R17：切分类时选的模型必须是**用户可选列表里**的那个分类的模型。
 *
 * 用户可自定义 `prefs.selectableAudioModels`（`provider.service.ts` 持久化任意数组），
 * 所以目录里存在 ≠ 用户能选。无条件用 `platform::<目录首条>` 会把 `audioModel`
 * 指向一个用户已停用的模型：下拉显示「已停用」，而请求仍会带着它发出去。
 */
describe('pickSelectableModelForKind 只选用户真能用的模型', () => {
  const tts = encodeChannelModel('platform', 'minimax-speech-2.8-hd')
  const music = encodeChannelModel('platform', 'stepaudio-3-music-preview')

  it('列表里有该分类模型时，返回列表里那个值（保留渠道前缀）', () => {
    expect(pickSelectableModelForKind('music', [tts, music])).toBe(music)
  })

  it('该分类模型全被用户停用时返回 undefined（调用方据此不改写 audioModel）', () => {
    expect(pickSelectableModelForKind('music', [tts])).toBeUndefined()
    expect(pickSelectableModelForKind('music', [])).toBeUndefined()
  })

  it('BYOK 音频模型（目录外，缺省 voice）不进 design/music 的交集', () => {
    const byok = encodeChannelModel('ch1', 'my-custom-tts')
    expect(pickSelectableModelForKind('voice', [byok])).toBe(byok)
    expect(pickSelectableModelForKind('design', [byok])).toBeUndefined()
  })
})

describe('audioKindOfModelValue', () => {
  it('目录外模型按缺省 voice 判（与服务端 assertAudioKindMatchesModel 同源）', () => {
    expect(audioKindOfModelValue(encodeChannelModel('ch1', 'whatever'))).toBe('voice')
    expect(audioKindOfModelValue('bare-model-name')).toBe('voice')
    expect(audioKindOfModelValue(encodeChannelModel('platform', 'stepaudio-3-music-preview'))).toBe(
      'music',
    )
  })
})

/**
 * 🔴 R18：design 的内容在 `scripts` / `roles` / `instruction` 里（三者至少一项非空）。
 *
 * 之前 `hasRefs` 没按 kind 门控 ⇒ 挂了 ref 但内容全空也能提交，最终把
 * `scripts: []` / `roles: []` / 无 instruction 原样发给上游，失败形态来自上游
 * 而不是清晰的客户端信号。挂 ref 不能替代内容。
 */
describe('hasDesignContent 按三类内容判（不看 ref）', () => {
  it('三类全空 ⇒ 无内容', () => {
    expect(hasDesignContent({ roles: [], scripts: [], instruction: '' })).toBe(false)
    expect(
      hasDesignContent({
        roles: [{ role: '', voice: '' }],
        scripts: [{ role: '', text: '  ' }],
        instruction: '   ',
      }),
    ).toBe(false)
  })

  it('scripts / roles / instruction 任一非空即算有内容', () => {
    expect(hasDesignContent({ roles: [], scripts: [{ role: '', text: '下雨了' }], instruction: '' })).toBe(true)
    expect(
      hasDesignContent({ roles: [{ role: '旁白', voice: 'wenrounvsheng' }], scripts: [], instruction: '' }),
    ).toBe(true)
    // 只填 instruction 也允许提交（门槛不得收得过严）
    expect(hasDesignContent({ roles: [], scripts: [], instruction: '克制一点' })).toBe(true)
  })
})

/**
 * 🔴 切分类时目标模型的三态判定 —— 关键是**把「我不知道」与「我知道了但没有」分开**：
 *
 * - `selectable === null`（bootstrap 未就绪/ 加载失败）⇒ 我不知道用户能选什么 ⇒ 退回
 *   目录默认（kind 与模型自洽）。若此时也返回 undefined，`audioModel` 会留在原分类，
 *   提交后由服务端 `assertAudioKindMatchesModel` 返 400 —— 而 `CanvasPage` 明确吞掉
 *   bootstrap 失败（注释「Dock falls back to catalog defaults until bootstrap
 *   succeeds」），那条fallback 在该路径上会被打破。
 * - `selectable` 已知但该分类交集为空 ⇒ 不擅自改写用户的模型（上一轮 R17 的行为）。
 */
describe('resolveKindSwitchModel 区分「prefs 未知」与「交集为空」', () => {
  const tts = encodeChannelModel('platform', 'minimax-speech-2.8-hd')
  const music = encodeChannelModel('platform', 'stepaudio-3-music-preview')

  it('prefs 未知（null）⇒ 退回目录默认，保证 kind 与模型自洽（不会撞 400）', () => {
    const model = resolveKindSwitchModel('music', null)
    expect(model).toBeDefined()
    // 退回的模型必须真属于 music 分类，否则这正是那个必 400 的错配组合
    expect(audioKindOfModelValue(model!)).toBe('music')
  })

  it('prefs 已知且有该分类模型 ⇒ 用用户列表里那个值', () => {
    expect(resolveKindSwitchModel('music', [tts, music])).toBe(music)
  })

  it('prefs 已知但该分类一个都没留 ⇒ undefined（不改写用户的模型）', () => {
    expect(resolveKindSwitchModel('music', [tts])).toBeUndefined()
    expect(resolveKindSwitchModel('music', [])).toBeUndefined()
  })

  it('prefs 未知时对每个分类都给出自洽模型（不能只保 music）', () => {
    for (const kind of AUDIO_KIND_OPTIONS.map((o) => o.value)) {
      const model = resolveKindSwitchModel(kind, null)
      expect(model, `${kind} 在 prefs 未知时拿不到模型`).toBeDefined()
      expect(audioKindOfModelValue(model!)).toBe(kind)
    }
  })
})

/**
 * B3 遗留⑥ dockAudio 惰性求值：两派生导出（AUDIO_VOICE_OPTIONS / DEFAULT_AUDIO_VOICE）
 * 此前在模块加载时从种子常量固化，bootstrap 注入的目录（admin 后台新增 audio 条目）
 * 本会话不可见。现改为注入成功后经 `onStudioCatalogRowsChanged` 重算重绑 ——
 * 本组锁两种时序：注入前（种子派生值）与注入后（取值反映新条目）；外加重置还原。
 */
describe('AUDIO_VOICE_OPTIONS / DEFAULT_AUDIO_VOICE 注入后重算（B3 惰性求值）', () => {
  const seedOptions = () =>
    listModels('audio').flatMap((m) => m.voices ?? []).map((v) => ({ id: v.id, label: v.label }))

  afterAll(() => {
    __resetStudioCatalogForTests()
  })

  it('未注入时为种子常量派生值（冷启动渲染零漂移）', () => {
    expect(AUDIO_VOICE_OPTIONS).toEqual(seedOptions())
    expect(DEFAULT_AUDIO_VOICE).toBe('female-shaonv')
  })

  it('注入含新音色的目录后，选项与默认音色反映新条目（ESM live binding）', () => {
    // 全量替换 rows：目录里只有后台新增的一个 TTS 条目 ⇒ 派生值只能来自注入内容
    setStudioCatalogEntries([
      {
        modelKey: 'admin-tts-x',
        displayName: '后台 TTS X',
        gatewayModelId: 'admin-tts-x',
        modality: 'audio',
        audioKind: 'voice',
        providerBinding: 'gateway-openai-compat',
        voices: [{ id: 'admin-voice-x', label: '后台音色 X' }],
        params: {},
        defaults: { voice: 'admin-voice-x' },
      },
    ] satisfies StudioModelEntry[])
    expect(AUDIO_VOICE_OPTIONS).toEqual([{ id: 'admin-voice-x', label: '后台音色 X' }])
    expect(DEFAULT_AUDIO_VOICE).toBe('admin-voice-x')
  })

  it('重置回种子初态后派生值同步还原（__resetStudioCatalogForTests 同样通知重算）', () => {
    __resetStudioCatalogForTests()
    expect(AUDIO_VOICE_OPTIONS).toEqual(seedOptions())
    expect(DEFAULT_AUDIO_VOICE).toBe('female-shaonv')
  })
})
