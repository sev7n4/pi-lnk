import { describe, expect, it, vi } from 'vitest'
import * as shared from '@lnkpi/shared'
import {
  buildAudioRequest,
  buildEffectiveVideoPrompt,
  buildVideoProviderGenerateOptions,
  buildVideoProviderOptions,
  buildImageProviderOptions,
  buildEffectiveImagePrompt,
  buildImageProviderGenerateOptions,
  ensureSeedanceRefTags,
  Seedance1xUnsupportedError,
} from './generation-adapter'
import { buildVideoReferenceBundle } from './video-refs'

describe('buildAudioRequest', () => {
  it('maps native speed/volume/pitch for minimax and prefixes language when needed', () => {
    const r = buildAudioRequest({
      mergedText: '你好世界',
      modelKey: 'minimax-speech-2.8-hd',
      voice: 'female-tender',
      emotion: 'happy',
      language: 'zh',
      speed: 1.2,
      volume: 1,
      pitch: 0,
    })
    expect(r.options.model).toBeTruthy()
    expect(r.options.speed).toBe(1.2)
    expect(r.meta.droppedFields.every((d) => d.reason)).toBe(true)
    if (r.meta.promptPrefixApplied) {
      expect(r.text.startsWith(r.meta.promptPrefixApplied) || r.text.includes('中文')).toBe(true)
    }
  })

  it('records modelFallback for unknown audio model', () => {
    const r = buildAudioRequest({ mergedText: 'hi', modelKey: 'nope' })
    expect(r.meta.modelFallback).toBe(true)
  })

  // U7（2026-10-06）：StepFun 情感走 instruction，**不进朗读正文**。
  // 若误用 promptPrefix，「情绪=欢快」会被照字念出来。
  it('maps StepFun emotion to instruction and keeps it out of the spoken text', () => {
    const r = buildAudioRequest({
      mergedText: '欢迎来到秋日上新专场',
      modelKey: 'stepaudio-3-tts',
      voice: 'cixingnansheng',
      emotion: 'happy',
      speed: 1.1,
    })
    expect(r.options.instruction).toBeTruthy()
    expect(r.options.instruction).not.toContain('秋日上新')
    expect(r.text).toBe('欢迎来到秋日上新专场')
    expect(r.meta.promptPrefixApplied).toBeUndefined()
    expect(r.meta.nativeParams.instruction).toBe(r.options.instruction)
  })

  it('omits instruction for neutral emotion (upstream default is already neutral)', () => {
    const r = buildAudioRequest({
      mergedText: '中性朗读',
      modelKey: 'stepaudio-3-tts',
      emotion: 'neutral',
    })
    expect(r.options.instruction).toBeUndefined()
  })

  it('drops pitch/language for StepFun instead of sending unsupported fields', () => {
    const r = buildAudioRequest({
      mergedText: '台词',
      modelKey: 'step-tts-mini',
      pitch: 2,
      language: 'zh',
    })
    expect(r.options).not.toHaveProperty('pitch')
    expect(r.options).not.toHaveProperty('language')
    const dropped = r.meta.droppedFields.map((d) => d.field)
    expect(dropped).toContain('pitch')
    expect(r.meta.promptPrefixApplied).toBeUndefined()
  })

  it('falls back to the entry default voice when a Minimax voice id is passed for StepFun', () => {
    const r = buildAudioRequest({
      mergedText: '台词',
      modelKey: 'stepaudio-3-tts',
      voice: 'female-shaonv',
    })
    // 关键回归：用户存量偏好是 minimax 音色 id，直接透传会让 StepFun 返 400
    expect(r.options.voice).not.toBe('female-shaonv')
    expect(r.options.voice).toBe('livelybreezy-female')
    expect(r.meta.droppedFields.some((d) => d.field === 'voice')).toBe(true)
  })
})

describe('buildVideoProviderOptions', () => {
  it('uses native image_urls for seedance multi-ref', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/a.png' },
      { refKey: 'I2', mediaType: 'image', url: 'https://cdn/b.png' },
    ])
    const r = buildVideoProviderOptions({
      modelKey: 'seedance-2.0-min',
      duration: 5,
      aspectRatio: '16:9',
      resolution: '720p',
      referenceBundle: bundle,
    })
    expect(r.meta.refImageMode).toBe('native')
    expect(r.meta.refWire).toBe('apimart_multimodal')
    expect(r.providerOptions.referenceImages).toEqual([
      'https://cdn/a.png',
      'https://cdn/b.png',
    ])
    expect(r.meta.nativeParams.image_urls).toEqual([
      'https://cdn/a.png',
      'https://cdn/b.png',
    ])
    expect(r.meta.nativeParams.size).toBe('16:9')
    expect(r.meta.nativeParams.aspectRatio).toBeUndefined()
    expect(r.effectivePromptSuffix).toBeUndefined()
  })

  it.each(['S2', 'S3'] as const)(
    'requests the last frame for seedance %s generations',
    (scenario) => {
      const bundle = buildVideoReferenceBundle([
        { refKey: 'I1', mediaType: 'image', url: 'https://cdn/a.png' },
      ])
      const r = buildVideoProviderOptions({
        modelKey: 'seedance-2.0-min',
        referenceBundle: bundle,
        scenario,
      })

      expect(r.providerOptions.returnLastFrame).toBe(true)
    },
  )

  it('does not request the last frame for seedance first-last generation', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/first.png' },
      { refKey: 'I2', mediaType: 'image', url: 'https://cdn/last.png' },
    ])
    const r = buildVideoProviderOptions({
      modelKey: 'seedance-2.0-min',
      videoMode: 'first_last_frame',
      referenceBundle: bundle,
    })

    expect(r.providerOptions.returnLastFrame).toBeUndefined()
  })

  it('uses agnes keyframes for 2+ images on agnes', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/a.png' },
      { refKey: 'I2', mediaType: 'image', url: 'https://cdn/b.png' },
    ])
    const r = buildVideoProviderOptions({
      modelKey: 'agnes-video-v2.0',
      referenceBundle: bundle,
    })
    expect(r.meta.refWire).toBe('agnes_keyframes')
    expect(r.providerOptions.referenceImages).toHaveLength(2)
    expect(r.image).toBeUndefined()
  })

  it('uses agnes keyframes for 2+ images on agnes-video-2.5-flash', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/a.png' },
      { refKey: 'I2', mediaType: 'image', url: 'https://cdn/b.png' },
    ])
    const r = buildVideoProviderOptions({
      modelKey: 'agnes-video-2.5-flash',
      referenceBundle: bundle,
    })
    expect(r.meta.refWire).toBe('agnes_keyframes')
    expect(r.providerOptions.referenceImages).toHaveLength(2)
    expect(r.providerOptions.duration).toBeGreaterThanOrEqual(4)
  })

  it('keeps referenceImages backward compatibility', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'agnes-video-v2.0',
      referenceImages: ['https://cdn.example/a.png'],
    })
    expect(r.image).toBe('https://cdn.example/a.png')
    expect(r.meta.refWire).toBe('agnes_single_image')
    expect(r.meta.referenceImageCount).toBe(1)
  })

  it('builds seedance tags, consistency prompt, and server options', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/a.png', label: '人物' },
      { refKey: 'V1', mediaType: 'video', url: 'https://cdn/v.mp4', label: '运镜' },
    ])
    const built = buildVideoProviderOptions({
      modelKey: 'seedance-2.0-min',
      referenceBundle: bundle,
    })
    expect(ensureSeedanceRefTags('保持 @Image1', bundle)).toBe('保持 @Image1 @Video1')
    expect(buildEffectiveVideoPrompt('保持角色', built)).toMatch(
      /保持角色 @Image1 @Video1[\s\S]*【参考图一致性】/,
    )
    expect(buildVideoProviderGenerateOptions(built)).toEqual(built.providerOptions)
    expect(built.meta).toMatchObject({
      scenario: 'S6',
      refVideoMode: 'native',
      refAudioMode: 'none',
      responseMode: 'async_task',
    })
  })

  it('strips user @Image10 when bundle has only 9 images', () => {
    const bundle = buildVideoReferenceBundle(
      Array.from({ length: 9 }, (_, index) => ({
        refKey: `I${index + 1}`,
        mediaType: 'image' as const,
        url: `https://cdn/${index + 1}.png`,
      })),
    )
    expect(ensureSeedanceRefTags('参考 @Image10 风格', bundle)).not.toContain('@Image10')
    expect(ensureSeedanceRefTags('参考 @Image10 风格', bundle)).toContain('@Image1')
  })

  it('strips zero-index @Image0/@Video0/@Audio0 tags (1-based only)', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/1.png' },
      { refKey: 'V1', mediaType: 'video', url: 'https://cdn/v.mp4' },
      { refKey: 'A1', mediaType: 'audio', url: 'https://cdn/a.mp3' },
    ])
    const result = ensureSeedanceRefTags(
      '参考 @Image0 @Video0 @Audio0 @图片0 风格',
      bundle,
    )
    expect(result).not.toContain('@Image0')
    expect(result).not.toContain('@Video0')
    expect(result).not.toContain('@Audio0')
    expect(result).not.toContain('@图片0')
    expect(result).toContain('@Image1')
    expect(result).toContain('@Video1')
    expect(result).toContain('@Audio1')
  })

  it('preserves @Image1 and does not treat @Image10 as a match', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/1.png' },
    ])
    expect(ensureSeedanceRefTags('保持 @Image1', bundle)).toBe('保持 @Image1')
    const withTen = ensureSeedanceRefTags('use @Image10 only', bundle)
    expect(withTen).not.toContain('@Image10')
    expect(withTen).toMatch(/@Image1\b/)
  })

  it('clamps seedance prompt image tags to the 9 provider references', () => {
    const bundle = buildVideoReferenceBundle(
      Array.from({ length: 10 }, (_, index) => ({
        refKey: `I${index + 1}`,
        mediaType: 'image' as const,
        url: `https://cdn/${index + 1}.png`,
      })),
    )
    const built = buildVideoProviderOptions({
      modelKey: 'seedance-2.0-min',
      referenceBundle: bundle,
    })

    const prompt = buildEffectiveVideoPrompt('保持角色 @Image10', built)

    expect(built.providerOptions.referenceImages).toHaveLength(9)
    expect(prompt).toContain('@Image9')
    expect(prompt).not.toContain('@Image10')
  })

  it('resolves BYOK BytePlus base gateway hint to apimart_multimodal with mini variant', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/a.png' },
      { refKey: 'V1', mediaType: 'video', url: 'https://cdn/v.mp4' },
    ])
    const r = buildVideoProviderOptions({
      modelKey: 'doubao-seedance-2-0-260128',
      gatewayModelHint: 'doubao-seedance-2-0-260128',
      referenceBundle: bundle,
      channelBaseUrl: 'https://api.apimart.ai/v1',
    })
    expect(r.meta.refWire).toBe('apimart_multimodal')
    expect(r.model).toBe('doubao-seedance-2-0-260128')
    expect(r.meta.gatewayModelId).toBe('doubao-seedance-2-0-260128')
    expect(r.meta.variantTag).toBe('mini')
    expect(r.providerOptions.referenceImages).toEqual(['https://cdn/a.png'])
  })

  it('resolves BYOK fast gateway hint to apimart_multimodal with fast variant clamp', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/a.png' },
    ])
    const r = buildVideoProviderOptions({
      modelKey: 'unknown-byok-video',
      gatewayModelHint: 'doubao-seedance-2.0-fast',
      resolution: '1080p',
      referenceBundle: bundle,
      channelBaseUrl: 'https://api.apimart.ai/v1',
    })
    expect(r.meta.refWire).toBe('apimart_multimodal')
    expect(r.model).toBe('doubao-seedance-2.0-fast')
    expect(r.meta.gatewayModelId).toBe('doubao-seedance-2.0-fast')
    expect(r.meta.variantTag).toBe('fast')
    expect(r.resolution).toBe('720p')
    expect(r.meta.droppedFields.some((d) => d.field === 'resolution')).toBe(true)
  })

  it('includes variantTag in meta for catalog seedance standard', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'seedance-2.0',
      resolution: '1080p',
    })
    expect(r.meta.variantTag).toBe('standard')
    expect(r.resolution).toBe('1080p')
    expect(r.model).toBe('doubao-seedance-2.0')
  })

  it('includes variantTag in meta for catalog seedance fast with resolution clamp', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'seedance-2.0-fast',
      resolution: '1080p',
    })
    expect(r.meta.variantTag).toBe('fast')
    expect(r.resolution).toBe('720p')
    expect(r.meta.droppedFields.some((d) => d.field === 'resolution')).toBe(true)
  })

  it('throws Seedance1xUnsupportedError for 1.x BYOK gateway hint', () => {
    expect(() =>
      buildVideoProviderOptions({
        modelKey: 'doubao-seedance-1-0-lite-i2v-250428',
        gatewayModelHint: 'doubao-seedance-1-0-lite-i2v-250428',
        channelBaseUrl: 'https://api.apimart.ai/v1',
      }),
    ).toThrow(Seedance1xUnsupportedError)
    try {
      buildVideoProviderOptions({
        modelKey: 'doubao-seedance-1-0-lite-i2v-250428',
        gatewayModelHint: 'doubao-seedance-1-0-lite-i2v-250428',
        channelBaseUrl: 'https://api.apimart.ai/v1',
      })
    } catch (err) {
      expect(err).toBeInstanceOf(Seedance1xUnsupportedError)
      expect((err as Error).message).toMatch(/不支持.*Seedance 1\.x/)
    }
  })

  it('drops video and audio prompt tags before first-last scenario inference', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/first.png' },
      { refKey: 'I2', mediaType: 'image', url: 'https://cdn/last.png' },
      { refKey: 'V1', mediaType: 'video', url: 'https://cdn/style.mp4' },
      { refKey: 'A1', mediaType: 'audio', url: 'https://cdn/music.mp3' },
    ])
    const built = buildVideoProviderOptions({
      modelKey: 'seedance-2.0-min',
      videoMode: 'first_last_frame',
      referenceBundle: bundle,
    })

    const prompt = buildEffectiveVideoPrompt(
      '首尾帧从 @Image1 过渡到 @图片2，忽略 @Video1 和 @Audio1',
      built,
    )

    expect(prompt).toContain('首帧')
    expect(prompt).toContain('末帧')
    expect(prompt).not.toMatch(/@(?:Image|图片)\d+\b/)
    expect(prompt).not.toContain('@Video1')
    expect(prompt).not.toContain('@Audio1')
    expect(built.meta.scenario).toBe('S5')
  })

  it('passes seed to seedance provider options when native', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'seedance-2.0-min',
      seed: 42,
    })
    expect(r.providerOptions.seed).toBe(42)
    expect(r.meta.nativeParams.seed).toBe(42)
  })

  it('passes seed and negativePrompt for agnes when native', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'agnes-video-v2.0',
      seed: 7,
      negativePrompt: 'watermark',
    })
    expect(r.providerOptions.seed).toBe(7)
    expect(r.providerOptions.negativePrompt).toBe('watermark')
    expect(r.meta.nativeParams.negative_prompt).toBe('watermark')
  })

  it('drops negativePrompt for seedance with droppedFields', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'seedance-2.0-min',
      negativePrompt: 'watermark',
    })
    expect(r.providerOptions.negativePrompt).toBeUndefined()
    expect(r.meta.droppedFields).toContainEqual(
      expect.objectContaining({ field: 'negativePrompt' }),
    )
  })

  it('wires fal_h3_max first image into image and referenceImages', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'h3-max-turbo',
      referenceImages: ['https://cdn/first.png'],
    })
    expect(r.meta.refWire).toBe('fal_h3_max')
    expect(r.meta.refImageMode).toBe('native')
    expect(r.image).toBe('https://cdn/first.png')
    expect(r.providerOptions.image).toBe('https://cdn/first.png')
    expect(r.providerOptions.referenceImages).toEqual(['https://cdn/first.png'])
    expect(r.providerOptions.imageWithRoles).toBeUndefined()
    expect(r.effectivePromptSuffix).toBeUndefined()
  })

  it('wires fal_h3_max first+last frames without prompt suffix', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/first.png' },
      { refKey: 'I2', mediaType: 'image', url: 'https://cdn/last.png' },
    ])
    const r = buildVideoProviderOptions({
      modelKey: 'h3-max',
      videoMode: 'first_last_frame',
      referenceBundle: bundle,
    })
    expect(r.meta.refWire).toBe('fal_h3_max')
    expect(r.providerOptions.image).toBe('https://cdn/first.png')
    expect(r.providerOptions.referenceImages).toEqual([
      'https://cdn/first.png',
      'https://cdn/last.png',
    ])
    expect(r.providerOptions.imageWithRoles).toEqual([
      { url: 'https://cdn/first.png', role: 'first_frame' },
      { url: 'https://cdn/last.png', role: 'last_frame' },
    ])
    expect(r.effectivePromptSuffix).toBeUndefined()
  })

  it('wires fal_h3_max two refs as first/last even without first_last_frame mode', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'h3-max-turbo',
      referenceImages: ['https://cdn/a.png', 'https://cdn/b.png', 'https://cdn/c.png'],
    })
    expect(r.providerOptions.referenceImages).toEqual([
      'https://cdn/a.png',
      'https://cdn/b.png',
    ])
    expect(r.providerOptions.imageWithRoles).toEqual([
      { url: 'https://cdn/a.png', role: 'first_frame' },
      { url: 'https://cdn/b.png', role: 'last_frame' },
    ])
    expect(r.effectivePromptSuffix).toBeUndefined()
  })

  it('wires minimax_h3_content first image into image and referenceImages', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'minimax-h3',
      referenceImages: ['https://cdn/first.png'],
    })
    expect(r.meta.refWire).toBe('minimax_h3_content')
    expect(r.meta.refImageMode).toBe('native')
    expect(r.image).toBe('https://cdn/first.png')
    expect(r.providerOptions.image).toBe('https://cdn/first.png')
    expect(r.providerOptions.referenceImages).toEqual(['https://cdn/first.png'])
    expect(r.providerOptions.imageWithRoles).toEqual([
      { url: 'https://cdn/first.png', role: 'first_frame' },
    ])
    expect(r.effectivePromptSuffix).toBeUndefined()
  })

  it('wires minimax_h3_content first+last frames without prompt suffix', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/first.png' },
      { refKey: 'I2', mediaType: 'image', url: 'https://cdn/last.png' },
    ])
    const r = buildVideoProviderOptions({
      modelKey: 'minimax-h3',
      videoMode: 'first_last_frame',
      referenceBundle: bundle,
    })
    expect(r.meta.refWire).toBe('minimax_h3_content')
    expect(r.providerOptions.image).toBe('https://cdn/first.png')
    expect(r.providerOptions.referenceImages).toEqual([
      'https://cdn/first.png',
      'https://cdn/last.png',
    ])
    expect(r.providerOptions.imageWithRoles).toEqual([
      { url: 'https://cdn/first.png', role: 'first_frame' },
      { url: 'https://cdn/last.png', role: 'last_frame' },
    ])
    expect(r.effectivePromptSuffix).toBeUndefined()
  })

  it('image_to_video uses only the first image as first_frame', () => {
    const r = buildVideoProviderOptions({
      modelKey: 'minimax-h3',
      videoMode: 'image_to_video',
      referenceImages: ['https://cdn/a.png', 'https://cdn/b.png', 'https://cdn/c.png'],
    })
    expect(r.providerOptions.image).toBe('https://cdn/a.png')
    expect(r.providerOptions.referenceImages).toEqual(['https://cdn/a.png'])
    expect(r.providerOptions.imageWithRoles).toEqual([
      { url: 'https://cdn/a.png', role: 'first_frame' },
    ])
  })

  it.each([undefined, 'image_to_video'] as const)(
    'drops video and audio refs as metadata_only when videoMode is %s',
    (videoMode) => {
      const bundle = buildVideoReferenceBundle([
        { refKey: 'I1', mediaType: 'image', url: 'https://cdn/first.png' },
        { refKey: 'V1', mediaType: 'video', url: 'https://cdn/style.mp4' },
        { refKey: 'A1', mediaType: 'audio', url: 'https://cdn/music.mp3' },
      ])
      const r = buildVideoProviderOptions({
        modelKey: 'minimax-h3',
        videoMode,
        referenceBundle: bundle,
      })
      expect(r.meta.refWire).toBe('minimax_h3_content')
      expect(r.meta.refVideoMode).toBe('metadata_only')
      expect(r.meta.refAudioMode).toBe('metadata_only')
      expect(r.providerOptions.referenceVideos).toBeUndefined()
      expect(r.providerOptions.referenceAudios).toBeUndefined()
      expect(r.effectivePromptSuffix).toBeUndefined()
      expect(r.meta.droppedFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'referenceVideos' }),
          expect.objectContaining({ field: 'referenceAudios' }),
        ]),
      )
    },
  )

  it('reference_to_video passes image/video/audio refs natively', () => {
    const bundle = buildVideoReferenceBundle([
      { refKey: 'I1', mediaType: 'image', url: 'https://cdn/a.png' },
      { refKey: 'I2', mediaType: 'image', url: 'https://cdn/b.png' },
      { refKey: 'V1', mediaType: 'video', url: 'https://cdn/v.mp4' },
      { refKey: 'A1', mediaType: 'audio', url: 'https://cdn/a.mp3' },
    ])
    const r = buildVideoProviderOptions({
      modelKey: 'minimax-h3',
      videoMode: 'reference_to_video',
      referenceBundle: bundle,
    })
    expect(r.providerOptions.videoMode).toBe('reference_to_video')
    expect(r.providerOptions.referenceImages).toEqual(['https://cdn/a.png', 'https://cdn/b.png'])
    expect(r.providerOptions.referenceVideos).toEqual(['https://cdn/v.mp4'])
    expect(r.providerOptions.referenceAudios).toEqual(['https://cdn/a.mp3'])
    expect(r.providerOptions.imageWithRoles).toBeUndefined()
    expect(r.meta.refVideoMode).toBe('native')
    expect(r.meta.refAudioMode).toBe('native')
    expect(r.meta.droppedFields).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'referenceVideos' }),
      ]),
    )
  })

  it('reference_to_video throws when image refs exceed MiniMax H3 limit', () => {
    const bundle = buildVideoReferenceBundle(
      Array.from({ length: 10 }, (_, i) => ({
        refKey: `I${i + 1}`,
        mediaType: 'image' as const,
        url: `https://cdn/${i + 1}.png`,
      })),
    )
    expect(() =>
      buildVideoProviderOptions({
        modelKey: 'minimax-h3',
        videoMode: 'reference_to_video',
        referenceBundle: bundle,
      }),
    ).toThrow('图最多 9 张')
  })
})

describe('buildImageProviderOptions', () => {
  it('passes modelId size n with none refImageMode when no references', () => {
    const r = buildImageProviderOptions({
      modelKey: 'seedream-5.0-pro',
      aspectRatio: '16:9',
      resolution: '2K',
      n: 2,
      referenceImages: [],
    })
    expect(r.modelId).toBe('doubao-seedream-5-0-pro')
    expect(r.n).toBe(1)
    expect(r.size).toBe('16:9')
    expect(r.meta.nativeParams.resolution).toBe('2K')
    expect(r.meta.refImageMode).toBe('none')
    expect(r.meta.responseMode).toBe('async_task')
  })

  it('uses native apimart image_urls for seedream references', () => {
    const r = buildImageProviderOptions({
      modelKey: 'seedream-5.0-pro',
      aspectRatio: '16:9',
      resolution: '2K',
      n: 1,
      referenceImages: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
    })
    expect(r.referenceImages).toEqual([
      'https://cdn.example/a.png',
      'https://cdn.example/b.png',
    ])
    expect(r.meta.refImageMode).toBe('native')
    expect(r.meta.refWire).toBe('apimart_image_urls')
    expect(r.meta.nativeParams).toMatchObject({
      image_urls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      resolution: '2K',
      size: '16:9',
    })
  })

  it('uses native apimart image_urls for image2 multi-ref', () => {
    const r = buildImageProviderOptions({
      modelKey: 'image2',
      aspectRatio: '1:1',
      resolution: '4K',
      n: 2,
      referenceImages: ['https://cdn.example/a.png'],
    })
    expect(r.modelId).toBe('gpt-image-2-official')
    expect(r.meta.refImageMode).toBe('native')
    expect(r.meta.nativeParams.image_urls).toEqual(['https://cdn.example/a.png'])
    expect(r.meta.nativeParams.resolution).toBe('4k')
    expect(r.meta.nativeParams.quality).toBe('high')
    expect(r.n).toBe(2)
  })

  it('uses agnes extra_body.image for agnes-image refs', () => {
    const r = buildImageProviderOptions({
      modelKey: 'agnes-image-2.1-flash',
      aspectRatio: '16:9',
      resolution: '1K',
      pixelSize: '1024x576',
      n: 1,
      referenceImages: ['https://cdn.example/a.png'],
    })
    expect(r.meta.refImageMode).toBe('native')
    expect(r.meta.responseMode).toBe('sync_url')
    expect(r.meta.nativeParams).toMatchObject({
      image: ['https://cdn.example/a.png'],
      size: '1024x576',
    })
  })

  it('buildEffectiveImagePrompt omits ref-image tags for native mode but keeps consistency', () => {
    const built = buildImageProviderOptions({
      modelKey: 'agnes-image-2.1-flash',
      aspectRatio: '16:9',
      resolution: '1K',
      n: 1,
      referenceImages: ['https://cdn.example/a.png'],
    })
    const prompt = buildEffectiveImagePrompt('draw a cat', built, [
      { refKey: 'I1', label: '产品实拍' },
    ])
    expect(prompt).toContain('draw a cat')
    expect(prompt).not.toContain('[ref-image:')
    expect(prompt).toContain('【参考图一致性】')
    expect(prompt).toContain('I1')
  })

  it('uses legacy prompt tags for unknown models', () => {
    const r = buildImageProviderOptions({
      modelKey: 'navo-pro',
      aspectRatio: '16:9',
      resolution: '1K',
      n: 1,
      referenceImages: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
    })
    expect(r.meta.refImageMode).toBe('primary_image')
    expect(r.effectivePromptSuffix).toBe('[ref-image:https://cdn.example/b.png]')
  })

  it('BYOK passthrough keeps unknown gateway id off platform catalog default', () => {
    const r = buildImageProviderOptions({
      modelKey: 'brand-new-upstream-image',
      aspectRatio: '16:9',
      resolution: '1K',
      n: 1,
      referenceImages: ['https://cdn.example/a.png'],
      byok: true,
      channelBaseUrl: 'https://api.apimart.ai/v1',
    })
    expect(r.modelId).toBe('brand-new-upstream-image')
    expect(r.meta.gatewayModelId).toBe('brand-new-upstream-image')
    expect(r.meta.modelFallback).toBeUndefined()
    expect(r.meta.responseMode).toBe('async_task')
    expect(r.meta.refWire).toBe('apimart_image_urls')
  })

  it('recognizes APIMart gemini-3.6-flash alias as image2 with multi-ref wire', () => {
    const r = buildImageProviderOptions({
      modelKey: 'gemini-3.6-flash',
      aspectRatio: '16:9',
      resolution: '1K',
      n: 1,
      referenceImages: [
        'https://cdn.example/model.png',
        'https://cdn.example/product.png',
      ],
    })
    expect(r.modelId).toBe('gpt-image-2-official')
    expect(r.meta.gatewayModelId).toBe('gpt-image-2-official')
    expect(r.meta.responseMode).toBe('async_task')
    expect(r.meta.refWire).toBe('apimart_image_urls')
    expect(r.meta.modelFallback).toBeUndefined()
    expect(r.meta.nativeParams.image_urls).toHaveLength(2)
  })

  it('recognizes BYOK APIMart gateway model ids for async profile', () => {
    const r = buildImageProviderOptions({
      modelKey: 'doubao-seedream-5-0-pro',
      aspectRatio: '1:1',
      resolution: '1K',
      n: 1,
      referenceImages: [],
    })
    expect(r.meta.modelKey).toBe('doubao-seedream-5-0-pro')
    expect(r.meta.gatewayModelId).toBe('doubao-seedream-5-0-pro')
    expect(r.meta.responseMode).toBe('async_task')
    expect(r.meta.modelFallback).toBeUndefined()
  })

  it('buildImageProviderGenerateOptions forwards async profile fields', () => {
    const built = buildImageProviderOptions({
      modelKey: 'seedream-5.0-pro',
      aspectRatio: '16:9',
      resolution: '2K',
      n: 1,
      referenceImages: ['https://cdn.example/a.png'],
    })
    expect(buildImageProviderGenerateOptions(built)).toMatchObject({
      modelId: 'doubao-seedream-5-0-pro',
      size: '16:9',
      resolution: '2K',
      refWire: 'apimart_image_urls',
      responseMode: 'async_task',
      referenceImages: ['https://cdn.example/a.png'],
    })
  })
})

// 回归锁：生产 GenerationRecord.model 存的是 gatewayModelId
// （`doubao-seedance-2.0-mini`），getModelEntry 只按 modelKey 匹配 ⇒ 静默回退到
// agnes-video-v2.0 条目 ⇒ Seedance 声明的 generateAudio:'native' 被判不支持而丢弃
// （生产 16 次）。见 docs/superpowers/specs/2026-10-04-media-generation-audit.md §2.1
// ⚠️ 必须走 buildVideoProviderOptions 这条完整路径，不能手写 entry ——
// 手写 entry 跳过了 resolveModelKey，正是本缺陷的所在。
describe('buildVideoProviderOptions 对 gatewayModelId 的能力判定', () => {
  it('keeps generateAudio for a Seedance gateway id (no droppedFields)', () => {
    const out = buildVideoProviderOptions({
      modelKey: 'doubao-seedance-2.0-mini',
      generateAudio: true,
      duration: 5,
    })
    expect(out.meta.droppedFields.map((d) => d.field)).not.toContain('generateAudio')
    expect((out.meta.nativeParams as Record<string, unknown>).generate_audio).toBe(true)
    expect(out.providerOptions.generateAudio).toBe(true)
  })

  it('resolves the canonical modelKey while accepting the gateway id', () => {
    const out = buildVideoProviderOptions({ modelKey: 'doubao-seedance-2.0-mini', duration: 5 })
    expect(out.meta.modelKey).toBe('seedance-2.0-min')
    expect(out.meta.modelFallback).toBeUndefined()
  })

  it('still drops generateAudio for a model that genuinely lacks it (Agnes)', () => {
    const out = buildVideoProviderOptions({
      modelKey: 'agnes-video-v2.0',
      generateAudio: true,
      duration: 5,
    })
    expect(out.meta.droppedFields.map((d) => d.field)).toContain('generateAudio')
    expect(out.meta.droppedFields[0]?.reason).toMatch(/agnes-video-v2\.0/)
  })

  it('agrees whether the id is modelKey or gatewayModelId', () => {
    const viaKey = buildVideoProviderOptions({
      modelKey: 'seedance-2.0-min',
      generateAudio: true,
      duration: 5,
    })
    const viaGateway = buildVideoProviderOptions({
      modelKey: 'doubao-seedance-2.0-mini',
      generateAudio: true,
      duration: 5,
    })
    expect(viaGateway.meta.droppedFields).toEqual(viaKey.meta.droppedFields)
    expect(viaGateway.meta.nativeParams).toMatchObject(viaKey.meta.nativeParams)
  })
})

// ── B2 S2-1c：catalogRows 注入（DB 目录真源）────────────────────────────────
// 缺陷：agent 侧 resolve 只认常量目录，后台 admin 新增的模型（仅存于 DB）
// 查不到 ⇒ fallback:true ⇒ 静默用默认模型生成并计费。
// 修复：三个 builder 加可选 catalogRows，server 宿主注入 DB 缓存 rows；
// 缺省回落种子常量（与既有行为逐字节一致，非 server 宿主零改动）。
describe('catalogRows 注入（B2 S2-1c）', () => {
  // 「常量目录没有、DB 有」的 admin 新增条目（模拟 ModelCatalogEntry 转出的目录行）。
  const dbOnlyRows: shared.StudioModelEntry[] = [
    {
      modelKey: 'db-only-video',
      displayName: 'DB 新增视频模型',
      gatewayModelId: 'db-only-video-gw',
      modality: 'video',
      providerBinding: 'gateway-openai-compat',
      params: { model: 'native', duration: 'native', aspectRatio: 'native', resolution: 'native' },
    },
    {
      modelKey: 'db-only-image',
      displayName: 'DB 新增图像模型',
      gatewayModelId: 'db-only-image-gw',
      modality: 'image',
      providerBinding: 'gateway-openai-compat',
      params: { model: 'native', size: 'native', n: 'native' },
    },
    {
      modelKey: 'db-only-audio',
      displayName: 'DB 新增音频模型',
      gatewayModelId: 'db-only-audio-gw',
      modality: 'audio',
      audioKind: 'voice',
      providerBinding: 'gateway-openai-compat',
      params: { model: 'native', voice: 'native', speed: 'native' },
    },
  ]
  const catalogRows = [...shared.STUDIO_MODEL_CATALOG, ...dbOnlyRows]

  it('①注入 rows：video 命中 DB 新增条目（常量目录没有），不静默 fallback', () => {
    const out = buildVideoProviderOptions({
      modelKey: 'db-only-video',
      duration: 5,
      catalogRows,
    })
    expect(out.meta.modelKey).toBe('db-only-video')
    expect(out.meta.modelFallback).toBeUndefined()
    expect(out.providerOptions.model).toBe('db-only-video-gw')
    expect(out.meta.gatewayModelId).toBe('db-only-video-gw')
  })

  it('①注入 rows：image 命中 DB 新增条目', () => {
    const out = buildImageProviderOptions({
      modelKey: 'db-only-image',
      n: 1,
      referenceImages: [],
      catalogRows,
    })
    expect(out.meta.modelKey).toBe('db-only-image')
    expect(out.meta.modelFallback).toBeUndefined()
    expect(out.modelId).toBe('db-only-image-gw')
  })

  it('①注入 rows：audio 命中 DB 新增条目', () => {
    const out = buildAudioRequest({
      mergedText: 'hi',
      modelKey: 'db-only-audio',
      catalogRows,
    })
    expect(out.meta.modelKey).toBe('db-only-audio')
    expect(out.meta.modelFallback).toBeUndefined()
    expect(out.options.model).toBe('db-only-audio-gw')
  })

  it('②缺省（未注入）回落种子常量：DB-only 模型仍走既有 fallback 行为', () => {
    const out = buildVideoProviderOptions({ modelKey: 'db-only-video', duration: 5 })
    // 默认模型从 defaultModelKey 派生（2026-10-10 v2.0→2.5-flash 切换），不硬编码字面量
    expect(out.meta.modelKey).toBe(shared.defaultModelKey('video'))
    expect(out.meta.modelFallback).toBe(true)
    expect(out.providerOptions.model).toBe(shared.defaultModelKey('video'))
  })

  it('②注入种子常量 rows ≡ 不注入（逐字段对拍，覆盖三模态）', () => {
    const seed = shared.STUDIO_MODEL_CATALOG
    for (const key of ['seedance-2.0-min', 'doubao-seedance-2.0-mini', 'agnes-video-v2.0', undefined]) {
      expect(buildVideoProviderOptions({ modelKey: key, duration: 5, catalogRows: seed })).toEqual(
        buildVideoProviderOptions({ modelKey: key, duration: 5 }),
      )
    }
    for (const key of ['seedream-5.0-pro', 'agnes-image-2.1-flash', 'nope']) {
      expect(
        buildImageProviderOptions({ modelKey: key, n: 1, referenceImages: [], catalogRows: seed }),
      ).toEqual(buildImageProviderOptions({ modelKey: key, n: 1, referenceImages: [] }))
      expect(buildAudioRequest({ mergedText: 'hi', modelKey: key, catalogRows: seed })).toEqual(
        buildAudioRequest({ mergedText: 'hi', modelKey: key }),
      )
    }
  })

  it('②缺省行为对拍 shared 常量薄壳 resolveModelKey（audio 入口抽查）', () => {
    const expected = shared.resolveModelKey('audio', 'minimax-speech-2.8-hd')
    const out = buildAudioRequest({ mergedText: 'hi', modelKey: 'minimax-speech-2.8-hd' })
    expect(out.meta.modelKey).toBe(expected.modelKey)
    expect(out.meta.modelFallback).toBeUndefined()
  })
})
