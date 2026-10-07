import { describe, expect, it } from 'vitest'
import { encodeChannelModel, getModelEntry, listModels } from '@lnkpi/shared'
import {
  AUDIO_VOICE_OPTIONS,
  DEFAULT_AUDIO_VOICE,
  AUDIO_KIND_OPTIONS,
  audioKindOfModelValue,
  defaultVoiceForKind,
  hasDesignContent,
  modelsForAudioKind,
  pickSelectableModelForKind,
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
