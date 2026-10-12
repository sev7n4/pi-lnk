/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { resolveVideoModelCapabilities } from './videoModelCapabilities'
import { SEEDANCE_20_GATEWAYS } from './videoModelProfiles'
import {
  videoAspectRatioOptionsForCapabilities,
  videoResolutionOptionsForCapabilities,
  videoBaselineAspectOptionsForCapabilities,
  videoBaselineResolutionOptionsForCapabilities,
  snapVideoSettingsToCapabilities,
} from './videoSettingsOptions'
import { DEFAULT_VIDEO_SETTINGS } from './index'

describe('videoAspectRatioOptionsForCapabilities', () => {
  it('seedance standard includes 21:9 and adaptive', () => {
    const c = resolveVideoModelCapabilities('seedance-2.0', SEEDANCE_20_GATEWAYS.standard)
    const opts = videoAspectRatioOptionsForCapabilities(c)
    expect(opts.map((o) => o.value)).toContain('21:9')
    expect(opts.map((o) => o.value)).toContain('adaptive')
    expect(opts.find((o) => o.value === '21:9')?.label).toBe('21:9 超宽')
  })

  it('legacy profile keeps base trio only', () => {
    const c = resolveVideoModelCapabilities('kling-v1', 'kling-v1')
    const opts = videoAspectRatioOptionsForCapabilities(c)
    expect(opts.map((o) => o.value)).toEqual(['16:9', '9:16', '1:1'])
  })

  it('agnes includes 4:3 and 3:4 but not adaptive', () => {
    const c = resolveVideoModelCapabilities('agnes-video-v2.0', 'agnes-video-v2.0')
    const opts = videoAspectRatioOptionsForCapabilities(c)
    expect(opts.map((o) => o.value)).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4'])
  })

  it('agnes 2.5 flash includes 21:9 and only 720p', () => {
    const c = resolveVideoModelCapabilities('agnes-video-2.5-flash', 'agnes-video-2.5-flash')
    expect(videoAspectRatioOptionsForCapabilities(c).map((o) => o.value)).toEqual([
      '16:9',
      '9:16',
      '1:1',
      '4:3',
      '3:4',
      '21:9',
    ])
    expect(videoResolutionOptionsForCapabilities(c).map((o) => o.value)).toEqual(['720p'])
  })
})

describe('videoResolutionOptionsForCapabilities', () => {
  it('seedance standard includes 4k', () => {
    const c = resolveVideoModelCapabilities('seedance-2.0', SEEDANCE_20_GATEWAYS.standard)
    const opts = videoResolutionOptionsForCapabilities(c)
    expect(opts.map((o) => o.value)).toContain('4k')
    expect(opts.find((o) => o.value === '4k')?.label).toBe('4K')
  })

  it('seedance mini excludes 4k and 1080p', () => {
    const c = resolveVideoModelCapabilities('seedance-2.0-mini', SEEDANCE_20_GATEWAYS.mini)
    const opts = videoResolutionOptionsForCapabilities(c)
    expect(opts.map((o) => o.value)).toEqual(['480p', '720p'])
  })

  it('agnes caps at 1080p', () => {
    const c = resolveVideoModelCapabilities('agnes-video-v2.0', 'agnes-video-v2.0')
    const opts = videoResolutionOptionsForCapabilities(c)
    expect(opts.map((o) => o.value)).toEqual(['480p', '720p', '1080p'])
  })

  it('labels official H3 2k as 2K', () => {
    const opts = videoResolutionOptionsForCapabilities(resolveVideoModelCapabilities('minimax-h3'))
    expect(opts).toEqual(
      expect.arrayContaining([
        { value: '768p', label: '768p' },
        { value: '2k', label: '2K' },
      ]),
    )
  })
})

describe('videoBaselineAspectOptionsForCapabilities (seedance 基线全集置灰)', () => {
  it('seedance standard: baseline 全部可用 + adaptive 追加', () => {
    const c = resolveVideoModelCapabilities('seedance-2.0', SEEDANCE_20_GATEWAYS.standard)
    const opts = videoBaselineAspectOptionsForCapabilities(c)
    expect(opts.map((o) => o.value)).toEqual([
      '16:9',
      '9:16',
      '1:1',
      '4:3',
      '3:4',
      '21:9',
      'adaptive',
    ])
    expect(opts.every((o) => !o.disabled)).toBe(true)
  })

  it('seedance mini: 比例全集可用（mini 限制在分辨率不在比例）', () => {
    const c = resolveVideoModelCapabilities('seedance-2.0-mini', SEEDANCE_20_GATEWAYS.mini)
    const opts = videoBaselineAspectOptionsForCapabilities(c)
    expect(opts.every((o) => !o.disabled)).toBe(true)
  })

  it('agnes: 21:9 置灰、adaptive 不追加', () => {
    const c = resolveVideoModelCapabilities('agnes-video-v2.0', 'agnes-video-v2.0')
    const opts = videoBaselineAspectOptionsForCapabilities(c)
    expect(opts.filter((o) => o.disabled).map((o) => o.value)).toEqual(['21:9'])
    expect(opts.some((o) => o.value === 'adaptive')).toBe(false)
  })

  it('cogvideox: 整组置灰（模型自动处理）', () => {
    const c = resolveVideoModelCapabilities('cogvideox-flash', 'cogvideox-flash')
    const opts = videoBaselineAspectOptionsForCapabilities(c)
    expect(opts.filter((o) => !o.disabled)).toEqual([])
  })

  it('无 capabilities 时 baseline 全部可用', () => {
    const opts = videoBaselineAspectOptionsForCapabilities(undefined)
    expect(opts).toHaveLength(6)
    expect(opts.every((o) => !o.disabled)).toBe(true)
  })
})

describe('videoBaselineResolutionOptionsForCapabilities', () => {
  it('seedance standard: 480p/720p/1080p/4K 全可用', () => {
    const c = resolveVideoModelCapabilities('seedance-2.0', SEEDANCE_20_GATEWAYS.standard)
    const opts = videoBaselineResolutionOptionsForCapabilities(c)
    expect(opts.map((o) => o.value)).toEqual(['480p', '720p', '1080p', '4k'])
    expect(opts.every((o) => !o.disabled)).toBe(true)
  })

  it('agnes: 仅 720p 可用，其余置灰', () => {
    const c = resolveVideoModelCapabilities('agnes-video-2.5-flash', 'agnes-video-2.5-flash')
    const opts = videoBaselineResolutionOptionsForCapabilities(c)
    expect(opts.filter((o) => !o.disabled).map((o) => o.value)).toEqual(['720p'])
    expect(opts.filter((o) => o.disabled).map((o) => o.value)).toEqual(['480p', '1080p', '4k'])
  })

  it('minimax-h3: baseline 外的 768p/2K 以额外项追加且可用', () => {
    const c = resolveVideoModelCapabilities('minimax-h3', 'MiniMax-H3')
    const opts = videoBaselineResolutionOptionsForCapabilities(c)
    expect(opts.filter((o) => !o.disabled).map((o) => o.value)).toEqual(['768p', '2k'])
  })
})

describe('snapVideoSettingsToCapabilities (模型切换就近回落)', () => {
  it('seedance 15s → cogvideox 10s 并记录调整明细', () => {
    const c = resolveVideoModelCapabilities('cogvideox-flash', 'cogvideox-flash')
    const { next, adjusted } = snapVideoSettingsToCapabilities(
      { ...DEFAULT_VIDEO_SETTINGS, duration: 15 },
      c,
    )
    expect(next.duration).toBe(10)
    expect(next.aspectRatio).toBe('16:9')
    expect(next.resolution).toBe('720p')
    expect(adjusted).toEqual([
      { field: 'duration', from: 15, to: 10, reason: expect.stringContaining('10s') },
    ])
  })

  it('seedance 1080p/4K 值切到 agnes 2.5 flash 回落 720p、15s 回落 12s', () => {
    const c = resolveVideoModelCapabilities('agnes-video-2.5-flash', 'agnes-video-2.5-flash')
    const { next, adjusted } = snapVideoSettingsToCapabilities(
      { ...DEFAULT_VIDEO_SETTINGS, duration: 15, resolution: '4k', aspectRatio: '16:9' },
      c,
    )
    expect(next.duration).toBe(12)
    expect(next.resolution).toBe('720p')
    expect(next.aspectRatio).toBe('16:9')
    expect(adjusted.map((a) => a.field).sort()).toEqual(['duration', 'resolution'])
  })

  it('切到 cogvideox：比例/分辨率由模型接管不回落，仅时长离散化', () => {
    const c = resolveVideoModelCapabilities('cogvideox-flash', 'cogvideox-flash')
    const { next, adjusted } = snapVideoSettingsToCapabilities(
      { ...DEFAULT_VIDEO_SETTINGS, duration: 8, resolution: '1080p', aspectRatio: '21:9' },
      c,
    )
    expect(next.duration).toBe(10)
    expect(next.resolution).toBe('1080p')
    expect(next.aspectRatio).toBe('21:9')
    expect(adjusted).toHaveLength(1)
    expect(adjusted[0]?.field).toBe('duration')
  })

  it('合法设置原样返回且 adjusted 为空', () => {
    const c = resolveVideoModelCapabilities('seedance-2.0', SEEDANCE_20_GATEWAYS.standard)
    const settings = { ...DEFAULT_VIDEO_SETTINGS, duration: 10, resolution: '1080p' } as const
    const { next, adjusted } = snapVideoSettingsToCapabilities(settings, c)
    expect(next).toEqual(settings)
    expect(adjusted).toEqual([])
  })

  it('无 capabilities 时原样返回', () => {
    const settings = { ...DEFAULT_VIDEO_SETTINGS, duration: 99 } as const
    const { next, adjusted } = snapVideoSettingsToCapabilities(settings, undefined)
    expect(next).toEqual(settings)
    expect(adjusted).toEqual([])
  })
})
