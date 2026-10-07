import { describe, expect, it } from 'vitest'
import { getModelEntry, listModels } from '@lnkpi/shared'
import {
  AUDIO_VOICE_OPTIONS,
  DEFAULT_AUDIO_VOICE,
  AUDIO_KIND_OPTIONS,
  defaultVoiceForKind,
  modelsForAudioKind,
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
