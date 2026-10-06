import { describe, expect, it } from 'vitest'
import {
  listModels,
  resolveModelKey,
  defaultModelKey,
  getModelEntry,
  normalizeModelRef,
} from './studioModelCatalog'
import { encodeChannelModel } from './providerChannels'

describe('studioModelCatalog', () => {
  it('lists fixed product models per modality', () => {
    expect(listModels('text').map((m) => m.modelKey)).toEqual([
      'agnes-2.0-flash',
      'gemini-3.1-flash',
      'deepseek-v4',
      'gpt-5.5',
    ])
    expect(listModels('image').map((m) => m.modelKey)).toEqual([
      'agnes-image-2.0-flash',
      'agnes-image-2.1-flash',
      'agnes-image-2.5-flash',
      'image2',
      'navo-pro',
      'seedream-5.0-pro',
      'midjourney-8.1',
    ])
    expect(listModels('video')).toHaveLength(11)
    expect(listModels('video').map((m) => m.modelKey)).toEqual(expect.arrayContaining([
      'agnes-video-v2.0',
      'agnes-video-2.5-flash',
      'h3-max-turbo',
      'h3-max',
      'minimax-h3',
    ]))
    expect(defaultModelKey('video')).toBe('agnes-video-v2.0')
    expect(getModelEntry('h3-max-turbo')).toMatchObject({
      displayName: 'H3 Max Turbo (fal)',
      gatewayModelId: 'minimax/h3-max-turbo',
      providerBinding: 'fal-http',
    })
    expect(getModelEntry('h3-max')).toMatchObject({
      displayName: 'H3 Max (fal)',
      gatewayModelId: 'minimax/h3-max',
      providerBinding: 'fal-http',
    })
    expect(getModelEntry('minimax-h3')).toMatchObject({
      displayName: 'MiniMax H3',
      gatewayModelId: 'MiniMax-H3',
      providerBinding: 'minimax-http',
    })
    expect(getModelEntry('seedance-2.0')?.gatewayModelId).toBe('doubao-seedance-2.0')
    expect(getModelEntry('seedance-2.0-fast')?.gatewayModelId).toBe('doubao-seedance-2.0-fast')
    expect(getModelEntry('seedance-2.0-face')?.gatewayModelId).toBe('doubao-seedance-2.0-face')
    expect(listModels('audio').map((m) => m.modelKey)).toEqual([
      'seed-audio-1.0',
      'minimax-speech-2.8-hd',
      'step-tts-mini',
      'stepaudio-3-tts',
    ])
  })

  // U7（2026-10-06）：StepFun 条目的 voice id 必须是官方音色清单里的**中文拼音 id**。
  // 回归锁：曾差点采用第三方聚合站文档里的 `lively-girl` 这类英文 id —— 那是该站自己的
  // 代理命名，直连 api.stepfun.com 会 400。
  it('registers StepFun TTS entries with official pinyin voice ids', () => {
    for (const key of ['step-tts-mini', 'stepaudio-3-tts']) {
      const entry = getModelEntry(key)
      expect(entry, key).toBeDefined()
      expect(entry!.modality).toBe('audio')
      expect(entry!.providerBinding).toBe('gateway-openai-compat')
      const ids = entry!.voices?.map((v) => v.id) ?? []
      expect(ids.length, key).toBeGreaterThan(0)
      expect(ids, key).toContain('cixingnansheng')
      // ⚠️ 黑名单而非正则：官方 id 本身含连字符（livelybreezy-female），
      // 用「像不像英文单词」的正则会误伤合法音色。第三方聚合站那套英文 id 才是要防的。
      for (const foreignId of ['lively-girl', 'vibrant-youth', 'soft-spoken-gentleman', 'magnetic-voiced-male']) {
        expect(ids, key).not.toContain(foreignId)
      }
      // 默认音色必须是本条目自己的音色（不能是 minimax 的 female-shaonv）
      expect(ids, key).toContain(entry!.defaults?.voice as string)
    }
    // getModelEntry 两种形态都要能命中（modelKey 与 gatewayModelId 同为 step-*）
    expect(getModelEntry('stepaudio-3-tts')?.gatewayModelId).toBe('stepaudio-3-tts')
  })

  it('marks StepFun pitch/language as dropped and emotion as instruction', () => {
    const step = getModelEntry('stepaudio-3-tts')!
    // 官方无 pitch 顶层参数 ⇒ 必须 metadataOnly（进 droppedFields，不静默吞）
    expect(step.params.pitch).toBe('metadataOnly')
    // 情感只能走 instruction（voice_label 对 3-tts 会报错）
    expect(step.params.emotion).toBe('instruction')
    expect(step.params.speed).toBe('native')
    expect(step.params.volume).toBe('native')
  })

  it('falls back unknown modelKey and sets fallback flag', () => {
    const r = resolveModelKey('image', 'not-a-real-model')
    expect(r.fallback).toBe(true)
    expect(r.modelKey).toBe(defaultModelKey('image'))
  })

  it('exposes voices for audio models', () => {
    const mini = getModelEntry('minimax-speech-2.8-hd')
    expect(mini?.voices?.length).toBeGreaterThan(0)
  })
})

describe('normalizeModelRef', () => {
  it('空值 → null', () => {
    expect(normalizeModelRef('image', undefined)).toBeNull()
    expect(normalizeModelRef('image', '')).toBeNull()
    expect(normalizeModelRef('image', '   ')).toBeNull()
  })

  it('已编码 ref 原样通过（BYOK 渠道不被改写）', () => {
    const out = normalizeModelRef('image', 'ch_byok_1::some-model')
    expect(out).toEqual({
      ref: 'ch_byok_1::some-model',
      channelId: 'ch_byok_1',
      modelName: 'some-model',
      fallback: false,
    })
  })

  it('裸名命中目录 → 归一为 platform::<modelKey>', () => {
    // 用目录里真实存在的 key（'image2'），否则命中的是默认回落值、测不到「命中」路径
    const known = resolveModelKey('image', 'image2').modelKey
    expect(known).toBe('image2')
    const out = normalizeModelRef('image', known)
    expect(out).toEqual({
      ref: encodeChannelModel('platform', known),
      channelId: 'platform',
      modelName: known,
      fallback: false,
    })
  })

  it('裸名未命中 → fallback:true（调用方据此拒绝，不静默采用）', () => {
    const out = normalizeModelRef('image', '完全不存在的模型-xyz')
    expect(out?.fallback).toBe(true)
    expect(out?.ref).toBe(encodeChannelModel('platform', defaultModelKey('image')))
  })

  it('跨模态裸名（video 名传给 image）也判 fallback', () => {
    const videoKey = resolveModelKey('video', defaultModelKey('video')).modelKey
    expect(normalizeModelRef('image', videoKey)?.fallback).toBe(true)
  })
})

// 回归锁：生产 GenerationRecord.model 字段存的是 gatewayModelId
// （如 `doubao-seedance-2.0-mini`），而 getModelEntry 只按 modelKey 精确匹配
// ⇒ 查不到 ⇒ resolveModelKey 静默回退到默认条目 `agnes-video-v2.0`
// ⇒ Seedance 明明声明 generateAudio:'native' 却被判不支持而丢弃（16 次）。
// 见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.1
describe('getModelEntry 双id 空间', () => {
  it('resolves a gateway model id to its catalog entry', () => {
    const entry = getModelEntry('doubao-seedance-2.0-mini')
    expect(entry?.modelKey).toBe('seedance-2.0-min')
    expect(entry?.params.generateAudio).toBe('native')
  })

  it('still resolves the canonical modelKey', () => {
    expect(getModelEntry('seedance-2.0-min')?.modelKey).toBe('seedance-2.0-min')
  })

  it('prefers an exact modelKey match over a gatewayModelId match', () => {
    const entry = getModelEntry('agnes-video-v2.0')
    expect(entry?.modelKey).toBe('agnes-video-v2.0')
  })

  it('returns undefined for an id in neither space', () => {
    expect(getModelEntry('totally-unknown-model')).toBeUndefined()
  })
})

describe('resolveModelKey 对 gateway id 不再回退', () => {
  it('does not fall back when a gateway id was passed', () => {
    const r = resolveModelKey('video', 'doubao-seedance-2.0-mini')
    expect(r.fallback).toBe(false)
    expect(r.entry.modelKey).toBe('seedance-2.0-min')
    expect(r.entry.params.generateAudio).toBe('native')
  })

  it('仍对真正未知的 id 回退并置fallback flag', () => {
    const r = resolveModelKey('video', 'no-such-video-model')
    expect(r.fallback).toBe(true)
  })

  it('跨模态的 gateway id 仍判回退（模态闸门不被绕过）', () => {
    const r = resolveModelKey('video', 'gemini-3.1-flash')
    expect(r.fallback).toBe(true)
  })
})

describe('id 空间一致性（改动 getModelEntry 的前置条件）', () => {
  it('video 目录内无重复 gatewayModelId', () => {
    const seen = new Set<string>()
    for (const entry of listModels('video')) {
      expect(seen.has(entry.gatewayModelId), `gatewayModelId 冲突: ${entry.gatewayModelId}`).toBe(false)
      seen.add(entry.gatewayModelId)
    }
  })

  it('全目录 modelKey 与 gatewayModelId 集合无交集歧义', () => {
    // 若某modelKey 同时是另一条目的 gatewayModelId，必须靠「modelKey 优先」消歧；
    // 这里锁住当前目录不存在该歧义，出现即说明目录数据变了需重新审视查找顺序
    const all = [
      ...listModels('text'),
      ...listModels('image'),
      ...listModels('video'),
      ...listModels('audio'),
    ]
    const modelKeys = new Set(all.map((e) => e.modelKey))
    for (const entry of all) {
      if (modelKeys.has(entry.gatewayModelId)) {
        expect(
          entry.modelKey,
          `存在歧义: ${entry.gatewayModelId} 既是 modelKey 又是 ${entry.modelKey} 的 gatewayModelId`,
        ).toBe(entry.gatewayModelId)
      }
    }
  })
})
