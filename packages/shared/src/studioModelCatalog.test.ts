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
    ])
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
