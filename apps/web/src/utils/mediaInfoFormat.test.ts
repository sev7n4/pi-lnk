import { describe, expect, it } from 'vitest'
import {
  formatMediaBytes,
  formatMediaDimensions,
  formatMediaDuration,
  formatMediaFormat,
  aspectRatioLabel,
  mediaInfoLine,
  mediaInfoParts,
} from './mediaInfoFormat'

describe('formatMediaDuration', () => {
  it('formats seconds as m:ss', () => {
    expect(formatMediaDuration(3)).toBe('0:03')
    expect(formatMediaDuration(65)).toBe('1:05')
  })
  it('formats hours as h:mm:ss', () => {
    expect(formatMediaDuration(3661)).toBe('1:01:01')
  })
  it('returns null for invalid', () => {
    expect(formatMediaDuration(undefined)).toBeNull()
    expect(formatMediaDuration(Number.NaN)).toBeNull()
    expect(formatMediaDuration(-1)).toBeNull()
  })
})

describe('formatMediaFormat', () => {
  it('maps common audio mime types', () => {
    expect(formatMediaFormat('audio/mpeg')).toBe('MP3')
    expect(formatMediaFormat('audio/wav')).toBe('WAV')
    expect(formatMediaFormat('mp3')).toBe('MP3')
  })
  it('returns null for empty', () => {
    expect(formatMediaFormat(undefined)).toBeNull()
    expect(formatMediaFormat('')).toBeNull()
  })
})

describe('aspectRatioLabel', () => {
  it('reduces dimensions', () => {
    expect(aspectRatioLabel(1920, 1080)).toBe('16:9')
    expect(aspectRatioLabel(1024, 1024)).toBe('1:1')
  })
  it('returns null when incomplete', () => {
    expect(aspectRatioLabel(100, undefined)).toBeNull()
  })
})

describe('existing helpers still work', () => {
  it('bytes and dims', () => {
    expect(formatMediaBytes(1024)).toBe('1.0KB')
    expect(formatMediaDimensions(10, 20)).toBe('10×20')
  })
})

/**
 * 媒体属性一行的分段判据（2026-10-24 走查②）。
 *
 * 背景：移动端瓦片重构后，「尺寸/分辨率 · 比例 · 大小」整条消失 ⇒ 把 PC
 * `MediaInfoSummary` 的分段逻辑提为共用纯函数，两端共用同一答案。
 * 判据与 PC 既有行为逐字一致（顺序、分隔符、缺失处理）。
 */
describe('mediaInfoParts 分段判据', () => {
  it('音频 = 时长 · 格式 · 大小', () => {
    expect(
      mediaInfoParts({ kind: 'audio', durationSec: 65, format: 'MP3', bytes: 1024 * 1024 }),
    ).toEqual(['1:05', 'MP3', '1.0MB'])
  })

  it('视频 = 分辨率 · 比例 · 大小（忽略 durationSec——PC 既有判据）', () => {
    expect(
      mediaInfoParts({
        kind: 'video',
        resolution: '720p',
        aspectRatio: '16:9',
        bytes: 2048,
        durationSec: 99,
      }),
    ).toEqual(['720p', '16:9', '2.0KB'])
  })

  it('图片 = 尺寸 · 比例 · 大小', () => {
    expect(
      mediaInfoParts({ kind: 'image', width: 1024, height: 1024, aspectRatio: '1:1', bytes: 512 }),
    ).toEqual(['1024×1024', '1:1', '512B'])
  })

  it('缺字段不猜不占位（只取有值项）', () => {
    expect(mediaInfoParts({ kind: 'image', width: 800, height: 600 })).toEqual(['800×600'])
    expect(mediaInfoParts({ kind: 'video', resolution: '1080p' })).toEqual(['1080p'])
    expect(mediaInfoParts({ kind: 'audio' })).toEqual([])
    // 空字符串字段等同于没有（format 前后空白也要剥）
    expect(mediaInfoParts({ kind: 'audio', format: '  ', bytes: 10 })).toEqual(['10B'])
  })

  it('无 kind 时按图片口径（向后兼容 PC 组件的默认 props）', () => {
    // aspectRatio 是**预计算字段**（buildNodeMediaInfoSummary 从 meta 带下来），
    // 分段函数不从宽高现算——缺字段就是不显示（不猜不占位）。
    expect(mediaInfoParts({ width: 100, height: 50, bytes: 100 })).toEqual(['100×50', '100B'])
    expect(mediaInfoParts({ width: 100, height: 50, aspectRatio: '2:1', bytes: 100 })).toEqual([
      '100×50',
      '2:1',
      '100B',
    ])
  })
})

describe('mediaInfoLine 拼接', () => {
  it('以「 · 」拼接（与 PC 展示一致）', () => {
    expect(
      mediaInfoLine({ kind: 'image', width: 1024, height: 768, aspectRatio: '4:3', bytes: 2048 }),
    ).toBe('1024×768 · 4:3 · 2.0KB')
  })

  it('无任何有效分段 ⇒ 空串（调用方据此不渲染）', () => {
    expect(mediaInfoLine({ kind: 'image' })).toBe('')
    expect(mediaInfoLine(undefined)).toBe('')
    expect(mediaInfoLine(null)).toBe('')
  })
})
