import { describe, expect, it } from 'vitest'
import { validateGenerationParams } from './agent-canvas-tools.service'

/**
 * set_node_generation_params 的入参校验判据。
 * 纯函数化以便独立单测打靶（本仓 agent 链路无 schema 兜底，白名单是唯一防线）。
 *
 * 区间/枚举真值来源（勿凭印象改）：
 * - imageAspect← packages/shared/src/imageParams.ts SUPPORTED_ASPECT_RATIOS
 * - imageResolution ← 1K|2K|4K
 * - videoSettings.resolution ← packages/shared/src/videoModelProfiles.ts VideoResolutionTier
 * - audio speed/volume/pitch ← apps/web/src/components/canvas/AudioVoiceSettingsSelector.vue
 *   （speed 0.5~2 / volume 0.1~2 / pitch -12~12）
 */

const imageNode = { type: 'image', data: { title: 'x' } }
const videoNode = { type: 'video', data: { title: 'y' } }
const audioNode = { type: 'audio', data: { title: 'z' } }

describe('validateGenerationParams', () => {
  it('image 节点接受合法比例/分辨率/数量', () => {
    const r = validateGenerationParams({
      params: { imageAspect: '3:4', imageResolution: '2K', imageCount: 2 },
      node: imageNode,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.applied).toEqual(['imageAspect', 'imageResolution', 'imageCount'])
    expect(r.data).toMatchObject({ imageAspect: '3:4', imageResolution: '2K', imageCount: 2 })
  })

  it('非法比例即拒并回 allowed 清单（禁止静默回落默认）', () => {
    const r = validateGenerationParams({ params: { imageAspect: '7:5' }, node: imageNode })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.allowed).toContain('3:4')
    expect(r.reason).toMatch(/imageAspect/)
  })

  it('非法分辨率即拒并回 allowed', () => {
    const r = validateGenerationParams({ params: { imageResolution: '8K' }, node: imageNode })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.allowed).toEqual(['1K', '2K', '4K'])
  })

  it('imageCount 越界即拒（0 / 5 / 小数）', () => {
    for (const bad of [0, 5, 1.5]) {
      expect(validateGenerationParams({ params: { imageCount: bad }, node: imageNode }).ok).toBe(false)
    }
  })

  it('video 嵌套设置按字段逐项校验', () => {
    const r = validateGenerationParams({
      params: {
        videoSettings: { aspectRatio: '9:16', duration: 8, resolution: '2k', generateAudio: true },
      },
      node: videoNode,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.videoSettings).toMatchObject({
      aspectRatio: '9:16',
      duration: 8,
      generateAudio: true,
    })
  })

  it('video duration 非正数 / 非数字即拒', () => {
    for (const bad of [0, -3, '8']) {
      const r = validateGenerationParams({
        params: { videoSettings: { aspectRatio: '9:16', duration: bad as never } },
        node: videoNode,
      })
      expect(r.ok).toBe(false)
    }
  })

  it('audio 数值越界即拒（speed 3 / volume 0 / pitch -13）', () => {
    for (const bad of [
      { audioSpeed: 3, audioVolume: 1, audioPitch: 1 },
      { audioSpeed: 1, audioVolume: 0, audioPitch: 1 },
      { audioSpeed: 1, audioVolume: 1, audioPitch: -13 },
    ]) {
      expect(validateGenerationParams({ params: bad, node: audioNode }).ok).toBe(false)
    }
  })

  it('audio 落**扁平**字段（AudioDockPanel 读的是 audioSpeed/audioVolume/audioPitch，不是嵌套对象）', () => {
    const r = validateGenerationParams({
      params: { audioSpeed: 1.2, audioVolume: 1, audioPitch: -3, audioEmotion: 'happy', audioLanguage: 'zh' },
      node: audioNode,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toEqual({
      audioSpeed: 1.2,
      audioVolume: 1,
      audioPitch: -3,
      audioEmotion: 'happy',
      audioLanguage: 'zh',
    })
    expect('audioSettings' in r.data).toBe(false)
  })

  it('audio 区间边界值通过（0.5 / 2 / -12 / 12）', () => {
    expect(
      validateGenerationParams({ params: { audioSpeed: 0.5, audioVolume: 0.1, audioPitch: -12 }, node: audioNode })
        .ok,
    ).toBe(true)
    expect(
      validateGenerationParams({ params: { audioSpeed: 2, audioVolume: 2, audioPitch: 12 }, node: audioNode })
        .ok,
    ).toBe(true)
  })

  it('跨模态字段写错节点类型即拒（image 参数写 video 节点）', () => {
    const r = validateGenerationParams({ params: { imageAspect: '3:4' }, node: videoNode })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.allowed).not.toContain('imageAspect')
  })

  it('空 params 即拒', () => {
    expect(validateGenerationParams({ params: {}, node: imageNode }).ok).toBe(false)
  })

  it('guideSceneId 合法时落库（场景按钮据此显示 active 态）', () => {
    const r = validateGenerationParams({
      params: { guideSceneId: 'ecom_xiaohongshu', imageAspect: '3:4' },
      node: imageNode,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.guideSceneId).toBe('ecom_xiaohongshu')
  })

  it('guideSceneId 不存在即拒（不接受模型编造的场景 id）', () => {
    const r = validateGenerationParams({ params: { guideSceneId: 'ecom_not_exist' }, node: imageNode })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/guideSceneId/)
  })

  it('未注册的裸字符串字段即拒', () => {
    const r = validateGenerationParams({ params: { foo: 'bar' }, node: imageNode })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/unsupported field/)
  })
})