// R1-T3: 移动端移除浮动 Dock（PC 端 DockStudioToolbar 浮条保持不动）。
// 沿用本仓库 CanvasPage 既有静态源码契约测试风格（不挂载 5000 行页面）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, 'CanvasPage.vue'), 'utf8')

describe('mobile floating dock removal (R1-T3)', () => {
  const dockBlock = page.match(/<DockStudioToolbar[\s\S]*?\/>/)?.[0] ?? ''

  it('DockStudioToolbar 在移动端不渲染（v-if 含 !isMobileLayout）', () => {
    expect(dockBlock, 'DockStudioToolbar 必须存在').not.toBe('')
    expect(dockBlock, '移动端必须排除浮动 Dock').toContain('!isMobileLayout')
  })

  it('桌面端门控保留（仍含 !refinePanelNode 等，仅新增 !isMobileLayout）', () => {
    expect(dockBlock).toContain('!refinePanelNode')
  })
})
