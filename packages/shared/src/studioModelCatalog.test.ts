import { describe, expect, it } from 'vitest'
import {
  STUDIO_MODEL_CATALOG,
  isDefaultModelKey,
  listModels,
  listModelsByAudioKind,
  listModelsByAudioKindFromRows,
  listModelsFromRows,
  normalizeModelRef,
  normalizeModelRefFromRows,
  resolveModelKey,
  resolveModelKeyFromRows,
  defaultModelKey,
  getModelEntry,
} from './studioModelCatalog'
import { encodeChannelModel } from './providerChannels'

describe('studioModelCatalog', () => {
  it('lists fixed product models per modality', () => {
    // 2026-10-09 S0-1：gemini-3.1-flash / deepseek-v4 / gpt-5.5 探活下架（agnes hub 无渠道）。
    // 2026-10-10：agnes-2.0-flash 上游消失，补 agnes-2.5-flash 接位（默认切换）。
    expect(listModels('text').map((m) => m.modelKey)).toEqual([
      'agnes-2.0-flash',
      'agnes-2.5-flash',
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
    // 2026-10-10：默认视频模型切换 —— agnes 官方下线 agnes-video-v2.0，默认改指向
    // 目录中仍在售的 agnes-video-2.5-flash（同时解除目录 DELETE 对 v2.0 的防呆）。
    expect(defaultModelKey('video')).toBe('agnes-video-2.5-flash')
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
      'stepaudio-3-gen-preview',
      'stepaudio-3-music-preview',
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

describe('audioKind 元数据', () => {
  it('every audio entry declares an audioKind（新增 audio 条目必须声明 kind）', () => {
    for (const entry of STUDIO_MODEL_CATALOG.filter((e) => e.modality === 'audio')) {
      expect(entry.audioKind, `${entry.modelKey} 缺 audioKind`).toBeTruthy()
    }
  })

  it('两条新模型归到正确 kind', () => {
    expect(getModelEntry('stepaudio-3-gen-preview')?.audioKind).toBe('design')
    expect(getModelEntry('stepaudio-3-music-preview')?.audioKind).toBe('music')
  })

  it('既有 4 条 audio 条目均为 voice', () => {
    for (const key of [
      'seed-audio-1.0',
      'minimax-speech-2.8-hd',
      'step-tts-mini',
      'stepaudio-3-tts',
    ]) {
      expect(getModelEntry(key)?.audioKind, key).toBe('voice')
    }
  })

  it('listModelsByAudioKind 只返回该 kind', () => {
    expect(listModelsByAudioKind('music').map((e) => e.modelKey)).toEqual([
      'stepaudio-3-music-preview',
    ])
    expect(listModelsByAudioKind('design').map((e) => e.modelKey)).toEqual([
      'stepaudio-3-gen-preview',
    ])
    expect(listModelsByAudioKind('voice').length).toBe(4)
  })

  it('audio 模态条目数 = 6，且默认模型不变（存量行为锁）', () => {
    expect(listModels('audio').length).toBe(6)
    expect(defaultModelKey('audio')).toBe('minimax-speech-2.8-hd')
  })

  it('新模型登记后能被 resolveModelKey 命中（不再静默回退）', () => {
    const r = resolveModelKey('audio', 'stepaudio-3-music-preview')
    expect(r.fallback).toBe(false)
    expect(r.modelKey).toBe('stepaudio-3-music-preview')
  })
})

// ── S2-1a（2026-10-10）：resolveModelKeyFromRows rows 注入形态 —— A3 全量回归 ──
// resolveModelKey 已重构为薄壳（常量层断言保留在上面各 describe，现锁的是种子）；
// 本层把既有 resolveModelKey 的全部 case 镜像到 rows 注入形态，两层逐 case 同结果。
// server 端 DB 包装器（apps/server model-catalog-store.ts）查表后调的就是这个纯函数。
describe('resolveModelKeyFromRows（rows 注入形态，S2-1a A3 全量回归）', () => {
  const ROWS = STUDIO_MODEL_CATALOG

  it('全量 26 条 fixture：按 modelKey 解析命中（模态闸门内）', () => {
    expect(ROWS).toHaveLength(26)
    for (const entry of ROWS) {
      const r = resolveModelKeyFromRows(ROWS, entry.modality, entry.modelKey)
      expect(r.fallback, entry.modelKey).toBe(false)
      expect(r.modelKey, entry.modelKey).toBe(entry.modelKey)
      expect(r.entry, entry.modelKey).toBe(entry)
    }
  })

  it('全量 26 条 fixture：gatewayModelId 形态也命中并归一到规范 modelKey', () => {
    for (const entry of ROWS) {
      const r = resolveModelKeyFromRows(ROWS, entry.modality, entry.gatewayModelId)
      expect(r.fallback, entry.gatewayModelId).toBe(false)
      expect(r.modelKey, entry.gatewayModelId).toBe(entry.modelKey)
    }
  })

  it('空 requested → 各模态默认条目，fallback:false', () => {
    for (const modality of ['text', 'image', 'video', 'audio'] as const) {
      const r = resolveModelKeyFromRows(ROWS, modality, undefined)
      expect(r.fallback, modality).toBe(false)
      expect(r.modelKey).toBe(defaultModelKey(modality))
      expect(r.entry.modelKey).toBe(defaultModelKey(modality))
      // null / 空串同为 falsy，走同一分支（旧行为逐 case 保持）
      expect(resolveModelKeyFromRows(ROWS, modality, null).modelKey).toBe(defaultModelKey(modality))
      expect(resolveModelKeyFromRows(ROWS, modality, '').fallback).toBe(false)
    }
  })

  it('未知 id / 跨模态 id → fallback 到该模态默认条目（确定性兜底，非 throw）', () => {
    const r = resolveModelKeyFromRows(ROWS, 'image', 'not-a-real-model')
    expect(r.fallback).toBe(true)
    expect(r.modelKey).toBe(defaultModelKey('image'))
    expect(r.entry.modelKey).toBe(defaultModelKey('image'))
    // 跨模态的 gateway id 仍判回退（模态闸门不被绕过）
    expect(resolveModelKeyFromRows(ROWS, 'video', 'gemini-3.1-flash').fallback).toBe(true)
    // S0-1 幽灵 key 在 rows 注入形态下同样不命中
    for (const ghost of ['deepseek-v4', 'gpt-5.5']) {
      const g = resolveModelKeyFromRows(ROWS, 'text', ghost)
      expect(g.fallback, ghost).toBe(true)
      expect(g.modelKey).toBe(defaultModelKey('text'))
    }
  })

  it('注入隔离：rows 子集里只有子集内条目可见（注入真的注入了，非读全局常量）', () => {
    const subset = ROWS.filter((e) => e.modelKey === 'image2')
    const hit = resolveModelKeyFromRows(subset, 'image', 'image2')
    expect(hit.fallback).toBe(false)
    expect(hit.entry.modelKey).toBe('image2')
    // 子集外的目录条目查不到 → 回落（且回落条目也从子集取；本子集无 image 默认条目）
    expect(resolveModelKeyFromRows(subset, 'image', 'navo-pro').fallback).toBe(true)
  })

  it('薄壳逐 case 对拍：resolveModelKey(常量) ≡ resolveModelKeyFromRows(常量 rows)', () => {
    for (const modality of ['text', 'image', 'video', 'audio'] as const) {
      expect(resolveModelKeyFromRows(ROWS, modality, undefined)).toEqual(resolveModelKey(modality, undefined))
    }
    for (const entry of ROWS) {
      expect(resolveModelKeyFromRows(ROWS, entry.modality, entry.modelKey)).toEqual(
        resolveModelKey(entry.modality, entry.modelKey),
      )
      expect(resolveModelKeyFromRows(ROWS, entry.modality, entry.gatewayModelId)).toEqual(
        resolveModelKey(entry.modality, entry.gatewayModelId),
      )
      expect(resolveModelKeyFromRows(ROWS, entry.modality, 'no-such-model')).toEqual(
        resolveModelKey(entry.modality, 'no-such-model'),
      )
    }
  })
})

describe('S2-1b 新增 rows 变体纯函数（web 下发目录驱动）', () => {
  it('listModelsFromRows ≡ listModels（常量 rows 对拍）', () => {
    for (const modality of ['text', 'image', 'video', 'audio'] as const) {
      expect(listModelsFromRows(STUDIO_MODEL_CATALOG, modality)).toEqual(listModels(modality))
      expect(listModelsFromRows(STUDIO_MODEL_CATALOG, modality)).toEqual(
        STUDIO_MODEL_CATALOG.filter((e) => e.modality === modality),
      )
    }
  })

  it('listModelsByAudioKindFromRows ≡ listModelsByAudioKind（常量 rows 对拍）', () => {
    for (const kind of ['voice', 'design', 'music'] as const) {
      expect(listModelsByAudioKindFromRows(STUDIO_MODEL_CATALOG, kind)).toEqual(
        listModelsByAudioKind(kind),
      )
    }
    // 注入真的注入：子集只含 music 条目时 voice 列表为空
    const musicOnly = STUDIO_MODEL_CATALOG.filter((e) => e.audioKind === 'music')
    expect(listModelsByAudioKindFromRows(musicOnly, 'music')).toHaveLength(musicOnly.length)
    expect(listModelsByAudioKindFromRows(musicOnly, 'voice')).toEqual([])
  })

  it('normalizeModelRefFromRows ≡ normalizeModelRef（常量 rows 对拍）', () => {
    expect(normalizeModelRefFromRows(STUDIO_MODEL_CATALOG, 'video', null)).toBeNull()
    expect(normalizeModelRefFromRows(STUDIO_MODEL_CATALOG, 'video', '  ')).toBeNull()
    expect(normalizeModelRefFromRows(STUDIO_MODEL_CATALOG, 'video', undefined)).toEqual(
      normalizeModelRef('video', undefined),
    )
    for (const entry of STUDIO_MODEL_CATALOG) {
      expect(normalizeModelRefFromRows(STUDIO_MODEL_CATALOG, entry.modality, entry.modelKey)).toEqual(
        normalizeModelRef(entry.modality, entry.modelKey),
      )
      expect(normalizeModelRefFromRows(STUDIO_MODEL_CATALOG, entry.modality, entry.gatewayModelId)).toEqual(
        normalizeModelRef(entry.modality, entry.gatewayModelId),
      )
      expect(normalizeModelRefFromRows(STUDIO_MODEL_CATALOG, entry.modality, 'no-such-model')).toEqual(
        normalizeModelRef(entry.modality, 'no-such-model'),
      )
    }
    // 已编码 ref 原样返回（不重编码）
    const encoded = encodeChannelModel('ch1', 'whatever')
    expect(normalizeModelRefFromRows(STUDIO_MODEL_CATALOG, 'text', encoded)).toEqual(
      normalizeModelRef('text', encoded),
    )
  })

  it('isDefaultModelKey：四个模态默认命中，其余不命中', () => {
    for (const modality of ['text', 'image', 'video', 'audio'] as const) {
      expect(isDefaultModelKey(defaultModelKey(modality))).toBe(true)
    }
    expect(isDefaultModelKey('no-such-model')).toBe(false)
    expect(isDefaultModelKey('navo-pro')).toBe(false)
  })
})
