import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileNodeTile from './MobileNodeTile.vue'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'MobileNodeTile.vue'), 'utf8')

function styleBlock(src: string): string {
  const m = /<style scoped>([\s\S]*?)<\/style>/.exec(src)
  return m ? m[1]! : ''
}

/** 挂载后读根元素 style 属性 → { width: '280px', height: '158px' } */
function tileStyle(type: string, data: Record<string, unknown> = {}): Record<string, string> {
  const w = mount(MobileNodeTile, {
    props: { id: 'n1', type: type as 'image', data: data as never },
  })
  const raw = w.attributes('style') ?? ''
  w.unmount()
  const out: Record<string, string> = {}
  for (const decl of raw.split(';')) {
    const idx = decl.indexOf(':')
    if (idx > 0) out[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim()
  }
  return out
}

/**
 * R1 走查风险闭环（2026-10-23）：磁贴此前零样式——节点无 style 时 vue-flow 按内容测量，
 * 图片/视频按原始像素尺寸渲染 ⇒ 每张图一个尺寸、溢出节点框。修复 = 磁贴自带确定外框
 * （与桌面同包络：图 280 / 视频 320）+ 媒体 object-fit: cover 裁填。
 */
describe('MobileNodeTile 媒体适配（fit）', () => {
  describe('磁贴外框尺寸（与桌面包络同源）', () => {
    it('图片磁贴按 imageAspect 装进 280 包络（16:9 → 280×158）', () => {
      const s = tileStyle('image', { url: 'https://example.com/a.png', imageAspect: '16:9' })
      expect(s.width).toBe('280px')
      expect(s.height).toBe('158px')
    })

    it('图片磁贴尊重显式 nodeSize（扩图应用链路优先级最高）', () => {
      const s = tileStyle('image', { url: 'https://example.com/a.png', nodeSize: { width: 100, height: 200 } })
      expect(s.width).toBe('100px')
      expect(s.height).toBe('200px')
    })

    it('视频磁贴按 videoSettings.aspectRatio 装进 320 包络（9:16 → 180×320）', () => {
      const s = tileStyle('video', { videoSettings: { aspectRatio: '9:16' } })
      expect(s.width).toBe('180px')
      expect(s.height).toBe('320px')
    })

    it('文本磁贴 280×160（NODE_SIZES 同值）', () => {
      const s = tileStyle('text', { content: '你好' })
      expect(s.width).toBe('280px')
      expect(s.height).toBe('160px')
    })

    it('音频磁贴 280×140（NODE_SIZES 同值）', () => {
      const s = tileStyle('audio', { url: 'https://example.com/a.mp3' })
      expect(s.width).toBe('280px')
      expect(s.height).toBe('140px')
    })
  })

  describe('scoped 样式（object-fit / 裁切 / 触控）', () => {
    it('存在 scoped 样式块', () => {
      expect(SRC).toContain('<style scoped>')
    })

    it('磁贴根元素撑满并裁切溢出（overflow: hidden + 圆角）', () => {
      const css = styleBlock(SRC)
      expect(css).toMatch(/\.mobile-node-tile\s*\{[^}]*overflow:\s*hidden/)
      expect(css).toMatch(/\.mobile-node-tile\s*\{[^}]*border-radius:\s*var\(--lnk-radius-lg\)/)
    })

    it('图片/视频 object-fit: cover 裁填磁贴（不溢出、不变形）', () => {
      const css = styleBlock(SRC)
      expect(css).toMatch(/\.mobile-node-media\s*\{[^}]*object-fit:\s*cover/)
      expect(css).toMatch(/\.mobile-node-media\s*\{[^}]*width:\s*100%/)
      // 走查②（2026-10-24）：属性行沉底后，媒体区从「height: 100%」改为
      // 「flex: 1 + min-height: 0」——弹性撑满剩余空间、可被属性行压缩，
      // 无属性行时仍等价于撑满（cover 裁填写在 .mobile-node-media-box 上）。
      expect(css).toMatch(/\.mobile-node-media\s*\{[^}]*flex:\s*1/)
      expect(css).toMatch(/\.mobile-node-media\s*\{[^}]*min-height:\s*0/)
      // 有效性配对：媒体盒纵向铺满（属性行沉底的容器前提）
      expect(css).toMatch(/\.mobile-node-media-box\s*\{[^}]*flex-direction:\s*column/)
      expect(css).toMatch(/\.mobile-node-media-box\s*\{[^}]*height:\s*100%/)
    })

    it('音频播放钮 ≥44px 触控热区', () => {
      const css = styleBlock(SRC)
      expect(css).toMatch(/\.mobile-audio-play\s*\{[^}]*width:\s*var\(--lnk-touch-target\)/)
      expect(css).toMatch(/\.mobile-audio-play\s*\{[^}]*height:\s*var\(--lnk-touch-target\)/)
    })

    it('文本磁贴 3 行截断（设计 §5.4）', () => {
      const css = styleBlock(SRC)
      expect(css).toMatch(/-webkit-line-clamp:\s*3/)
    })

    it('状态角标绝对定位，不挤占内容布局', () => {
      const css = styleBlock(SRC)
      expect(css).toMatch(/\.mobile-node-badge\s*\{[^}]*position:\s*absolute/)
    })

    it('零 --neo-* 旧令牌', () => {
      expect(SRC).not.toContain('--neo-')
    })
  })
})
