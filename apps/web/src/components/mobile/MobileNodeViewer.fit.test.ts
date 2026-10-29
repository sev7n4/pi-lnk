import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'MobileNodeViewer.vue'), 'utf8')

function styleBlock(src: string): string {
  const m = /<style scoped>([\s\S]*?)<\/style>/.exec(src)
  return m ? m[1]! : ''
}

/**
 * R1 走查风险闭环（2026-10-23）：查看器此前零样式——没有 fixed/inset 的全屏遮罩，
 * tap 图/视频/短文得到的是文档流里一个普通 div（不是灯箱）。修复 = fixed 贴视口
 * （2026-10-20 定位契约）+ 媒体 object-fit: contain 整图可见 + 44px 返回热区。
 */
describe('MobileNodeViewer 全屏查看器样式（fit）', () => {
  it('存在 scoped 样式块', () => {
    expect(SRC).toContain('<style scoped>')
  })

  it('全屏固定遮罩：position: fixed + inset: 0', () => {
    const css = styleBlock(SRC)
    expect(css).toMatch(/\.mobile-node-viewer\s*\{[^}]*position:\s*fixed/)
    expect(css).toMatch(/\.mobile-node-viewer\s*\{[^}]*inset:\s*0/)
  })

  it('灯箱媒体 object-fit: contain 整图可见（不裁切）', () => {
    const css = styleBlock(SRC)
    expect(css).toMatch(/\.viewer-media\s*\{[^}]*object-fit:\s*contain/)
  })

  it('右上 X ≥44px 触控热区（v1.5 P：X 迁 MobileViewerChrome 的 .mv-chrome-close）', () => {
    const chromeSrc = readFileSync(join(HERE, 'MobileViewerChrome.vue'), 'utf8')
    const css = styleBlock(chromeSrc)
    expect(css).toMatch(/\.mv-chrome-close\s*\{[^}]*width:\s*var\(--lnk-touch-target\)/)
    expect(css).toMatch(/\.mv-chrome-close\s*\{[^}]*height:\s*var\(--lnk-touch-target\)/)
  })

  it('⛔ 禁文本字符当图标（§4.11.5）：不得再出现左上 ‹', () => {
    expect(SRC).not.toMatch(/<button[^>]*>\s*‹\s*<\/button>/)
  })

  it('零 --neo-* 旧令牌', () => {
    expect(SRC).not.toContain('--neo-')
  })
})
