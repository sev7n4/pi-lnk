import { describe, expect, it } from 'vitest'
import type { ProbedMediaFile } from '@lnkpi/shared'
import {
  hasSummaryPayload,
  needsMediaInfoEnsure,
  summaryFromProbed,
  mergeNodeMediaInfo,
} from './nodeMediaInfo'

const okProbe = (partial: Partial<ProbedMediaFile>): ProbedMediaFile => ({
  url: 'https://x/a.bin',
  probeStatus: 'ok',
  ...partial,
})

describe('hasSummaryPayload', () => {
  it('true when display fields present', () => {
    expect(hasSummaryPayload({ kind: 'image', width: 1, height: 1 })).toBe(true)
    expect(hasSummaryPayload({ kind: 'audio', format: 'MP3' })).toBe(true)
    expect(hasSummaryPayload({ kind: 'image' })).toBe(false)
  })
})

describe('needsMediaInfoEnsure', () => {
  it('false without url', () => {
    expect(needsMediaInfoEnsure('image', undefined, '')).toBe(false)
  })
  it('true when missing payload', () => {
    expect(needsMediaInfoEnsure('image', undefined, 'https://x')).toBe(true)
  })
  // ⭐ 2026-10-27 三轮走查（回归①续）修订：判据从「有任意 payload」收紧为
  // 「该 kind 的**展示要素集**完整」——节点创建管道只落 bytes ⇒ hasSummaryPayload
  // 为 true ⇒ probe 被短路 ⇒ 磁贴底部永远只见「媒体大小」一段（真机现象）。
  // 要素集（与 mediaInfoParts 展示分段一一对应）：
  //   图片 = width+height(+bytes) · 视频 = resolution+aspectRatio(+bytes) · 音频 = durationSec+format(+bytes)
  it('false when image element set complete（width+height+bytes）', () => {
    expect(
      needsMediaInfoEnsure('image', { kind: 'image', width: 10, height: 10, bytes: 10 }, 'https://x'),
    ).toBe(false)
  })
  it('true when image has bytes only（要素集残缺 ⇒ 必须补 probe，回归根因）', () => {
    expect(needsMediaInfoEnsure('image', { kind: 'image', bytes: 10 }, 'https://x')).toBe(true)
  })
  it('false when video element set complete（resolution+aspectRatio+bytes）', () => {
    expect(
      needsMediaInfoEnsure(
        'video',
        { kind: 'video', resolution: '1280×720', aspectRatio: '16:9', bytes: 9 },
        'https://x',
      ),
    ).toBe(false)
  })
  it('true when video has bytes only（回归根因）', () => {
    expect(needsMediaInfoEnsure('video', { kind: 'video', bytes: 9 }, 'https://x')).toBe(true)
  })
  it('true for audio missing duration even if format present', () => {
    expect(
      needsMediaInfoEnsure('audio', { kind: 'audio', format: 'MP3', bytes: 1 }, 'https://x'),
    ).toBe(true)
  })
  it('true for audio missing format even if duration present（要素集残缺）', () => {
    expect(
      needsMediaInfoEnsure('audio', { kind: 'audio', durationSec: 3, bytes: 1 }, 'https://x'),
    ).toBe(true)
  })
})

describe('summaryFromProbed', () => {
  it('builds image summary', () => {
    const s = summaryFromProbed('image', okProbe({ width: 1920, height: 1080, bytes: 100 }))
    expect(s).toMatchObject({ kind: 'image', width: 1920, height: 1080, bytes: 100, aspectRatio: '16:9' })
  })
  it('builds audio format from mime', () => {
    const s = summaryFromProbed('audio', okProbe({ mimeType: 'audio/mpeg', bytes: 50 }))
    expect(s).toMatchObject({ kind: 'audio', format: 'MP3', bytes: 50 })
  })
  it('builds video with dims as resolution fallback', () => {
    const s = summaryFromProbed('video', okProbe({ width: 1280, height: 720, bytes: 9 }))
    expect(s?.kind).toBe('video')
    expect(s?.bytes).toBe(9)
    expect(s?.aspectRatio).toBe('16:9')
    expect(s?.resolution).toBe('1280×720')
  })
})

describe('mergeNodeMediaInfo', () => {
  it('does not clobber with empty next fields', () => {
    const merged = mergeNodeMediaInfo(
      { kind: 'audio', format: 'MP3', bytes: 10, durationSec: 3 },
      { kind: 'audio', format: undefined, bytes: 20 },
    )
    expect(merged).toEqual({ kind: 'audio', format: 'MP3', bytes: 20, durationSec: 3 })
  })
})
