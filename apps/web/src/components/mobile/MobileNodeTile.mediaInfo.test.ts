import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileNodeTile from './MobileNodeTile.vue'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'MobileNodeTile.vue'), 'utf8')

/**
 * 走查②（2026-10-24 真机）：瓦片卡面丢失媒体属性。
 *
 * 用户反馈：图片 / 视频 / 音频节点在画布卡片看不到原 WEB 端设计的属性信息
 * （尺寸 × 分辨率 × 大小）。产品裁决：**保留**（用户要求以顶尖产品经理视角
 * 审视——属性行是「这个节点到底是什么」的关键信息，与 PC 对等）。
 *
 * 修法：瓦片渲染 `data.mediaInfo`（PC 同一字段）的一行摘要，分段判据的
 * 单一真源在 `utils/mediaInfoFormat`（与 PC MediaInfoSummary 共用）。
 */
describe('MobileNodeTile 媒体属性行（走查②）', () => {
  it('图片节点渲染「尺寸 · 比例 · 大小」', () => {
    const w = mount(MobileNodeTile, {
      props: {
        id: 'n1',
        type: 'image',
        data: {
          url: 'https://example.com/a.png',
          // aspectRatio 是预计算字段（真实数据由 buildNodeMediaInfoSummary 从 meta 带下）
          mediaInfo: { kind: 'image', width: 1024, height: 768, aspectRatio: '4:3', bytes: 2048 },
        } as never,
      },
    })
    const info = w.find('[data-testid="mobile-node-media-info"]')
    expect(info.exists()).toBe(true)
    expect(info.text()).toBe('1024×768 · 4:3 · 2.0KB')
    // 属性行是媒体盒的沉底一行，媒体元素仍在
    expect(w.find('img.mobile-node-media').exists()).toBe(true)
    w.unmount()
  })

  it('视频节点渲染「分辨率 · 比例 · 大小」', () => {
    const w = mount(MobileNodeTile, {
      props: {
        id: 'n2',
        type: 'video',
        data: {
          url: 'https://example.com/a.mp4',
          mediaInfo: { kind: 'video', resolution: '720p', aspectRatio: '16:9', bytes: 3 * 1024 * 1024 },
        } as never,
      },
    })
    expect(w.find('[data-testid="mobile-node-media-info"]').text()).toBe('720p · 16:9 · 3.0MB')
    w.unmount()
  })

  it('音频节点渲染「时长 · 格式 · 大小」', () => {
    const w = mount(MobileNodeTile, {
      props: {
        id: 'n3',
        type: 'audio',
        data: {
          url: 'https://example.com/a.mp3',
          mediaInfo: { kind: 'audio', durationSec: 65, format: 'MP3', bytes: 1024 * 1024 },
        } as never,
      },
    })
    expect(w.find('[data-testid="mobile-node-media-info"]').text()).toBe('1:05 · MP3 · 1.0MB')
    // 波纹播放器仍在（属性行不挤占播放区）
    expect(w.find('.mobile-audio-wave').exists()).toBe(true)
    w.unmount()
  })

  it('无 mediaInfo ⇒ 不渲染属性行（不猜不占位）', () => {
    const w = mount(MobileNodeTile, {
      props: {
        id: 'n4',
        type: 'image',
        data: { url: 'https://example.com/a.png' } as never,
      },
    })
    expect(w.find('[data-testid="mobile-node-media-info"]').exists()).toBe(false)
    w.unmount()
  })

  it('mediaInfo 全字段缺失 ⇒ 不渲染属性行（空串即隐藏）', () => {
    const w = mount(MobileNodeTile, {
      props: {
        id: 'n5',
        type: 'image',
        data: { url: 'https://example.com/a.png', mediaInfo: { kind: 'image' } } as never,
      },
    })
    expect(w.find('[data-testid="mobile-node-media-info"]').exists()).toBe(false)
    w.unmount()
  })

  it('空节点（无 url）不渲染属性行（没有媒体就没有属性）', () => {
    const w = mount(MobileNodeTile, {
      props: {
        id: 'n6',
        type: 'image',
        data: { url: '', mediaInfo: { kind: 'image', width: 10, height: 10, bytes: 1 } } as never,
      },
    })
    expect(w.find('[data-testid="mobile-node-media-info"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('MobileNodeTile 属性行样式契约（令牌纪律）', () => {
  it('属性行用主题令牌，不新增裸 hex / rgba（theme-usage 棘轮）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    const rule = /\.mobile-node-media-info\s*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(rule, '必须能定位 .mobile-node-media-info 规则').not.toBe('')
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(rule).not.toMatch(/rgba?\(/)
    expect(rule).toMatch(/var\(--lnk-/)
  })

  it('媒体盒是纵向 flex：媒体区可压缩、属性行沉底', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    const box = /\.mobile-node-media-box\s*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(box, '必须能定位 .mobile-node-media-box 规则').not.toBe('')
    expect(box).toMatch(/display:\s*flex/)
    expect(box).toMatch(/flex-direction:\s*column/)
    const media = /\.mobile-node-media\s*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(media, '必须能定位 .mobile-node-media 规则').not.toBe('')
    expect(media).toMatch(/flex:\s*1/)
    expect(media).toMatch(/min-height:\s*0/)
  })
})
