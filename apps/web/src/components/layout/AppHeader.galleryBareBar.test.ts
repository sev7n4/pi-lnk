// 规格 §6.1 / §6.7（mobile-web-three-page-topbar-redesign）：创作空间（画廊 /canvases）
// 走**裸栏**——仅 logo + ＋，去掉 创作/发现 文字导航、ThemeToggle、AccountChrome。
// 移动 + WEB 同一组件、同一视觉；自审 S1「双栏坑」要求本守卫与 CanvasesPage 去自写栏同时成立。
// 静态契约（jsdom 不计算样式；同 CanvasPage.mobileChromeHygiene.test.ts 模式）
// + 行为契约（create 通道：自 CanvasesPage 页内按钮迁入裸栏 ＋ 盘后，唯一通道语义不丢）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const readComp = (p: string) => readFileSync(join(here, '..', p), 'utf8')
const appHeader = readComp('layout/AppHeader.vue')

/** 剥注释后再断言「某物已移除」——迁移记录写在注释里是规范（棘轮同款教训）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('AppHeader 画廊裸栏（/canvases）', () => {
  it('isGalleryRoute 判定 = route.path === "/canvases"', () => {
    expect(appHeader).toContain("route.path === '/canvases'")
  })

  it('画廊分支只渲染 🔍(gallery-search-toggle)，新建 ＋ 已删除，不含导航/主题/账号', () => {
    const galleryBlock = appHeader.match(/<template v-if="isGalleryRoute">[\s\S]*?<\/template>/)?.[0] ?? ''
    expect(galleryBlock, '必须能定位画廊裸栏模板块').toContain('<template v-if="isGalleryRoute">')
    expect(galleryBlock).toContain('data-testid="gallery-search-toggle"')
    expect(galleryBlock, '2026-11-20 用户裁定：两端顶栏 ＋ 删除').not.toContain('gallery-create')
    expect(galleryBlock).not.toContain('新建项目')
    // 裸栏不得混入全站 chrome
    expect(galleryBlock).not.toContain('ThemeToggle')
    expect(galleryBlock).not.toContain('AccountChrome')
    expect(galleryBlock).not.toContain('tab in tabs')
  })

  it('文字导航（创作/发现）在画廊路由隐藏（v-if="!isGalleryRoute"）', () => {
    expect(stripComments(appHeader)).toContain('v-if="!isGalleryRoute"')
    // 常规右簇（主题 + 账号）在 v-else，与裸栏互斥
    expect(stripComments(appHeader)).toMatch(/<\/template>\s*<div v-else/)
    // 有效性配对：常规分支确实含主题/账号入口（防空集假绿）
    const rightBlock = appHeader.match(/<div v-else[^>]*>[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? ''
    expect(rightBlock, '必须能定位常规右簇').toContain('AccountChrome')
  })
})

// 2026-11-20：＋ 的行为契约随入口迁到 CanvasesPage（PC 首卡 / 移动 FAB），此处只留裸栏结构守卫。

// ─── §13.1/A1+A2（v3 追加）：scroll-edge 材质化 ───
describe('AppHeader scroll-edge 材质化（§13.1）', () => {
  it('常驻材质退役：静态 class 无 border-b/bg-surface/backdrop（封条感主源）', () => {
    // 剥注释后断言：迁移记录写在注释里是规范
    const s = appHeader
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(s).not.toContain('border-b border-line-subtle')
    expect(s).not.toContain('bg-surface backdrop-blur-xl')
    // 材质态由 is-material 承载（滚动驱动）
    expect(s).toMatch(/'is-material': scrolled/)
  })

  it('材质态：bg + blur + inset 发丝线阴影（ghost 态零轮廓）', () => {
    expect(appHeader).toMatch(/\.app-header\.is-material\s*\{[^}]*var\(--lnk-surface\)/)
    expect(appHeader).toMatch(/\.app-header\.is-material\s*\{[^}]*backdrop-filter/)
    expect(appHeader).toMatch(/\.app-header\.is-material\s*\{[^}]*inset 0 -0\.5px 0 var\(--lnk-border-subtle\)/)
  })

  it('滚动驱动：阈值 8px、passive 监听、卸载清理', () => {
    expect(appHeader).toContain('SCROLL_THRESHOLD = 8')
    expect(appHeader).toContain("window.addEventListener('scroll', onScroll, { passive: true })")
    expect(appHeader).toContain("window.removeEventListener('scroll', onScroll)")
  })
})
