import { describe, expect, it } from 'vitest'
import {
  applyGuideSceneToPrompt,
  clearGuideScene,
  guideSceneParamsPatch,
  nearestImageCount,
} from './guideSceneApply'

describe('applyGuideSceneToPrompt', () => {
  it('prefills when prompt empty', () => {
    const r = applyGuideSceneToPrompt({ sceneId: 'g3_exact_text', currentPrompt: '' })
    expect(r.didPrefill).toBe(true)
    expect(r.prompt).toContain('{{TAGLINE}}')
    expect(r.prompt).toContain('标语')
    expect(r.guideSceneId).toBe('g3_exact_text')
  })

  it('does not overwrite non-empty prompt', () => {
    const r = applyGuideSceneToPrompt({ sceneId: 'g3_exact_text', currentPrompt: 'keep me' })
    expect(r.didPrefill).toBe(false)
    expect(r.prompt).toBe('keep me')
    expect(r.guideSceneId).toBe('g3_exact_text')
  })
})

describe('clearGuideScene', () => {
  it('clears guideSceneId without touching prompt', () => {
    expect(clearGuideScene()).toEqual({ guideSceneId: null })
  })
})

describe('nearestImageCount', () => {
  it('吸附到 selector 的合法档位 1|2|4', () => {
    expect(nearestImageCount(1)).toBe(1)
    expect(nearestImageCount(2)).toBe(2)
    expect(nearestImageCount(4)).toBe(4)
    expect(nearestImageCount(3)).toBe(2) // 就近（3 距 2 与 4 同距，取小）
    expect(nearestImageCount(5)).toBe(4)
  })

  it('非法输入回落 1（旧实现会把非1 强改回 1，会清掉 agent 预填的 x2）', () => {
    expect(nearestImageCount(0)).toBe(1)
    expect(nearestImageCount(-2)).toBe(1)
    expect(nearestImageCount('abc')).toBe(1)
    expect(nearestImageCount(undefined)).toBe(1)
    expect(nearestImageCount(2)).toBe(2) // 关键回归锁：2 必须保住
  })
})

describe('guideSceneParamsPatch（按模态分派键位）', () => {
  it('image 场景 → 扁平 imageAspect/imageResolution/imageCount', () => {
    const { patch, applied } = guideSceneParamsPatch({ sceneId: 'ecom_xiaohongshu' })
    expect(patch).toMatchObject({ imageAspect: '3:4', imageResolution: '1K', imageCount: 2 })
    expect(applied).toEqual(['imageAspect', 'imageResolution', 'imageCount'])
  })

  it('image 场景不得产出 video/audio 键（写错键位= 面板读不到，静默失效）', () => {
    const { patch } = guideSceneParamsPatch({ sceneId: 'ecom_xiaohongshu' })
    expect(patch).not.toHaveProperty('videoSettings')
    expect(patch).not.toHaveProperty('audioVoice')
  })

  it('video 场景 → 嵌套 videoSettings，且 durationHint 经回调解析成秒数', () => {
    const { patch } = guideSceneParamsPatch({
      sceneId: 'ecom_douyin',
      resolveDuration: () => 5,
    })
    expect(patch.videoSettings).toMatchObject({
      aspectRatio: '9:16',
      resolution: '1K',
      duration: 5,
      generateAudio: true,
    })
  })

  it('video 场景在无 model 上下文（无 resolveDuration）时不硬造 duration', () => {
    const { patch } = guideSceneParamsPatch({ sceneId: 'ecom_douyin' })
    expect(patch.videoSettings).toMatchObject({ aspectRatio: '9:16', generateAudio: true })
    expect(patch.videoSettings).not.toHaveProperty('duration')
  })

  it('未知场景 → 空 patch（不抛，前端不炸）', () => {
    expect(guideSceneParamsPatch({ sceneId: 'not_exist' })).toEqual({ patch: {}, applied: [] })
  })

  it('旧场景（只写 size）→ 无新键产出，size 由既有 mapPreferredSizeToAspect 路径处理', () => {
    const { patch } = guideSceneParamsPatch({ sceneId: 'g3_exact_text' })
    expect(patch).toEqual({})
  })
})
