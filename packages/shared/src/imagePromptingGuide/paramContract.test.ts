import { describe, expect, it } from 'vitest'
import {
  defaultGuideCapabilities,
  getGenerationScene,
  listGenerationScenes,
  resolveGuideRequest,
} from './index'
import { resolveImageSize } from '../imageParams'

describe('ParamContract 按模态分型（P0）', () => {
  it('image 场景可声明 aspectRatio / resolution / count', () => {
    const scene = getGenerationScene('ecom_xiaohongshu')
    expect(scene).toBeDefined()
    expect(scene!.modality).toBe('image')
    expect(scene!.preferredParams.aspectRatio).toBe('3:4')
    expect(scene!.preferredParams.resolution).toBe('1K')
    expect(scene!.preferredParams.count).toBe(2)
  })

  it('aspectRatio + resolution 能派生 size（旧 size 字段仍可用）', () => {
    const scene = getGenerationScene('ecom_xiaohongshu')!
    expect(resolveImageSize(scene.preferredParams.aspectRatio, scene.preferredParams.resolution)).toBe(
      '768x1024',
    )
  })

  it('resolveGuideRequest 会带上分型后的新字段', () => {
    const scene = getGenerationScene('ecom_xiaohongshu')!
    const r = resolveGuideRequest({ guide: scene, capabilities: defaultGuideCapabilities() })
    expect(r.applied).toContain('aspectRatio')
    expect(r.applied).toContain('resolution')
    expect(r.applied).toContain('count')
    expect(r.params.aspectRatio).toBe('3:4')
    expect(r.params.resolution).toBe('1K')
    expect(r.params.count).toBe(2)
  })

  it('userOverrides 逐字段覆盖分型字段', () => {
    const scene = getGenerationScene('ecom_xiaohongshu')!
    const r = resolveGuideRequest({
      guide: scene,
      capabilities: defaultGuideCapabilities(),
      userOverrides: { aspectRatio: '4:5' },
    })
    expect(r.params.aspectRatio).toBe('4:5')
    expect(r.params.resolution).toBe('1K')
  })

  it('backward compat：只写 size 的旧场景仍能解析', () => {
    const scene = getGenerationScene('g3_exact_text')!
    const r = resolveGuideRequest({ guide: scene, capabilities: defaultGuideCapabilities() })
    expect(r.params.size).toBe('1024x1536')
    expect(r.applied).toContain('size')
  })

  it('video 场景用 durationHint 表达意图，不写死 duration', () => {
    const scene = getGenerationScene('ecom_douyin')!
    expect(scene.modality).toBe('video')
    expect(scene.preferredParams.durationHint).toBe('short')
    expect(scene.preferredParams.duration).toBeUndefined()
  })

  it('ecom_platform 分组已注册且排在 photo_ad 之后', () => {
    const ecom = listGenerationScenes().filter((s) => s.groupId === 'ecom_platform')
    expect(ecom.length).toBeGreaterThanOrEqual(2)
  })
})