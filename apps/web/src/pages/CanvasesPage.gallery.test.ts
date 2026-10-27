// 规格 §6.1 / §6.7（mobile-web-three-page-topbar-redesign）：创作空间（画廊）去自写栏、
// 顶部裸栏上收 AppHeader。本守卫确认 CanvasesPage 不再自绘大标题/返回主页/常驻管理按钮，
// 仅保留「创作空间 · N 个」标题行 + 网格 + 共享 gallerySearchOpen 的搜索输入。
// 静态契约（jsdom 不计算样式；同 CanvasPage.mobileChromeHygiene.test.ts 模式）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, 'CanvasesPage.vue'), 'utf8')

/** 剥注释后再断言「某物已移除」——迁移记录写在注释里是规范（棘轮同款教训）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('CanvasesPage 画廊（去自写栏）', () => {
  it('标题行仅「创作空间 · N 个」+ 网格，无大 H1 / 返回主页', () => {
    const code = stripComments(page)
    expect(code).toContain('创作空间')
    expect(code).toContain('·')
    // 项目网格仍在（行卡形态）
    expect(code).toContain('grid-cols-2')
    // 自写大标题栏已移交 AppHeader 裸栏
    expect(code).not.toContain('<h1')
    expect(code).not.toContain('返回主页')
  })

  it('搜索输入共享 gallerySearchOpen（🔍 在 AppHeader，输入框在此按需展开）', () => {
    const code = stripComments(page)
    expect(code).toContain('gallerySearchOpen')
    expect(code).toContain('data-testid="canvases-search"')
    expect(code).toContain('v-if="gallerySearchOpen"')
  })

  it('多选态改长按进入（原常驻「管理」按钮退役）', () => {
    const code = stripComments(page)
    expect(code).toContain('startCardLongPress') // 长按进入多选
    expect(code).toContain('manageMode') // 多选态动作条
    // 无独立「管理」按钮（行内菜单/动作条替代）
    expect(code).not.toContain('>管理<')
  })
})
