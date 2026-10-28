// 规格 §13.3（mobile-web-three-page-topbar-redesign v3）：PC 创作空间网格卡墙。
// 静态契约：两视图（ProjectList 移动 / ProjectGrid PC）只许形态分叉、不许行为分叉——
// 共享数据源（rows+mgr prop）、共享菜单弹层、共享时间口径；卡墙网格用容器自适应列数。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')
const grid = read('ProjectGrid.vue')
const list = read('ProjectList.vue')
const page = read('../../pages/CanvasesPage.vue')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('ProjectGrid（PC 卡墙 · §13.3/C1）', () => {
  it('网格 = 容器自适应列数 auto-fill minmax(220px, 1fr)', () => {
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(220px,\s*1fr\)\)/)
  })

  it('交互契约与行卡同构：长按多选 + session-card-menu-anchor + 菜单弹层共享', () => {
    expect(grid).toContain('session-card-menu-anchor')
    expect(grid).toContain("@pointerdown=\"$emit('press-start', p.id)\"")
    expect(grid).toContain('data-testid="canvases-row-menu"')
    expect(grid).toContain('<ProjectCardMenu')
    // 菜单弹层唯一出处：两视图都不得内联重命名/副本/删除按钮
    expect(stripComments(grid)).not.toContain('重命名')
    expect(stripComments(list)).not.toContain('重命名')
  })

  it('⛔ 封面 relative 包裹保留（CanvasCoverFallback absolute inset-0 兜底，缺它黑屏）', () => {
    expect(grid).toMatch(/relative block aspect-\[4\/3\]/)
  })

  it('相对时间口径单源：两视图都消费 canvases/relativeTime 模块', () => {
    expect(grid).toContain("from './relativeTime'")
    expect(list).toContain("from './relativeTime'")
    expect(stripComments(page)).not.toMatch(/function relativeTime/)
  })
})

describe('CanvasesPage 视图切换（§13.3/C3）', () => {
  it('断点切换：isMobileLayout → ProjectList，否则 ProjectGrid；两视图接同一组事件', () => {
    expect(page).toContain('useAgentMobileLayout')
    expect(page).toMatch(/<ProjectList[\s\S]*?v-else-if="mgr\.filtered\.value\.length && isMobileLayout"/)
    expect(page).toMatch(/<ProjectGrid[\s\S]*?v-else-if="mgr\.filtered\.value\.length"/)
    // 同一数据源 + 同一组交互接线（防两视图行为漂移）
    for (const evt of ['@open="openCanvas"', '@press-start="startCardLongPress"', '@press-cancel="cancelCardLongPress"']) {
      expect(page.match(new RegExp(evt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(2)
    }
  })
})
