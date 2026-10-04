import { describe, expect, it } from 'vitest'
import { getModelEntry, listModels } from '@lnkpi/shared'
import { AUDIO_VOICE_OPTIONS, DEFAULT_AUDIO_VOICE } from './dockAudio'

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
