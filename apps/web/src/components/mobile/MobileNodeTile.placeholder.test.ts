import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileNodeTile from './MobileNodeTile.vue'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'MobileNodeTile.vue'), 'utf8')

/**
 * 空节点类型可辨识性（2026-10-23 真机走查）：
 *
 * 走查反馈——新建的四个节点里，音频有波纹、文本有「空文本」，都能一眼认出；
 * 但**图片节点（正方形）与视频节点（矩形条）视觉上完全无法区分类型**，
 * 只能靠形状猜。因为空图/空视频磁贴里没有任何媒体元素（`v-if="data?.url"` 为假），
 * 只剩卡面 + 描边 ⇒ 几何形状成了唯一线索。
 *
 * 修法：空图/空视频磁贴渲染「类型图标 + 类型名」占位（复用 NeoBaseNode 同款 SVG path），
 * 与音频波纹 / 文本「空文本」形成一致的类型可辨识性。
 */
describe('MobileNodeTile 空节点类型占位（辨识度）', () => {
  it('空图片节点渲染类型占位（图标 + 「图片」标签）', () => {
    const w = mount(MobileNodeTile, {
      props: { id: 'n1', type: 'image', data: { url: '' } as never },
    })
    const ph = w.find('.mobile-node-placeholder')
    expect(ph.exists()).toBe(true)
    expect(ph.text()).toContain('图片')
    expect(ph.find('svg').exists()).toBe(true)
  })

  it('空视频节点渲染类型占位（图标 + 「视频」标签）', () => {
    const w = mount(MobileNodeTile, {
      props: { id: 'n2', type: 'video', data: { url: '' } as never },
    })
    const ph = w.find('.mobile-node-placeholder')
    expect(ph.exists()).toBe(true)
    expect(ph.text()).toContain('视频')
    expect(ph.find('svg').exists()).toBe(true)
  })

  it('空视频节点不再渲染裸 <video> 元素（矩形条来源）', () => {
    const w = mount(MobileNodeTile, {
      props: { id: 'n3', type: 'video', data: { url: '' } as never },
    })
    expect(w.find('video').exists()).toBe(false)
  })

  it('有 url 的图片节点不渲染占位（媒体优先）', () => {
    const w = mount(MobileNodeTile, {
      props: { id: 'n4', type: 'image', data: { url: 'https://example.com/a.png' } as never },
    })
    expect(w.find('.mobile-node-placeholder').exists()).toBe(false)
    expect(w.find('img.mobile-node-media').exists()).toBe(true)
  })

  it('有 url 的视频节点不渲染占位', () => {
    const w = mount(MobileNodeTile, {
      props: { id: 'n5', type: 'video', data: { url: 'https://example.com/a.mp4' } as never },
    })
    expect(w.find('.mobile-node-placeholder').exists()).toBe(false)
    expect(w.find('video.mobile-node-media').exists()).toBe(true)
  })

  it('空音频与空图/空视频同型（回归②：占位分支，不再渲染波形/播放键）；文本照旧「空文本」', () => {
    // ⭐ 2026-10-27 真机回归②：旧断言「空音频也有波纹」被推翻——用户实证空音频
    // 的占位波形无法与有产物区分 ⇒ 空音频落类型占位分支（音频图标 + 「音频」）。
    const wa = mount(MobileNodeTile, {
      props: { id: 'n6', type: 'audio', data: { url: '' } as never },
    })
    expect(wa.find('.mobile-node-placeholder').exists()).toBe(true)
    expect(wa.find('.mobile-node-placeholder-label').text()).toBe('音频')
    expect(wa.find('.mobile-audio-wave').exists()).toBe(false)
    expect(wa.find('.mobile-audio-play').exists()).toBe(false)

    const wt = mount(MobileNodeTile, {
      props: { id: 'n7', type: 'text', data: { content: '' } as never },
    })
    expect(wt.find('.mobile-node-text').text()).toBe('空文本')
    expect(wt.find('.mobile-node-placeholder').exists()).toBe(false)
  })

  it('占位样式存在（图标 + 标签排版，可见性）', () => {
    expect(SRC).toContain('.mobile-node-placeholder')
    // 占位必须居中且有明确色（用 L2 令牌，不用裸 hex）
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    const rule = /\.mobile-node-placeholder[^{]*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(rule).toMatch(/display:\s*flex/)
    expect(rule).toMatch(/align-items:\s*center/)
    expect(rule).toMatch(/justify-content:\s*center/)
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(rule).not.toMatch(/rgba?\(/)
  })

  it('图标 path 复用 NeoBaseNode 同款（image=rect+circle+path，video=polygon+rect）', () => {
    // image: <rect x="2.5" y="3" width="19" height="18" rx="3" /> + <circle cx="8" cy="9" r="2" /> + <path d="M21.5 15.5l-5-5L4 21" />
    expect(SRC).toContain('M21.5 15.5l-5-5L4 21')
    // video: <polygon points="23 7 16 12 23 17 23 7" /> + <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    expect(SRC).toContain('23 7 16 12 23 17 23 7')
  })
})
