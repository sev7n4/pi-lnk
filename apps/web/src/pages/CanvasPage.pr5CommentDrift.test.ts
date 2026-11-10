// PR5 规格-实现漂移防回潮（2026-11-10，依据 docs/agent/pr5-canvas-overlay-residuals-spike.md §3）。
// 背景：过时的注释曾诱导后续会话去「迁移已不存在的浮动胶囊」（#816 踩过的坑）。
// 静态契约层（同 mobileChromeHygiene / viewport 模式），三条判据：
//   ① 三处过时描述不得回潮；② 裁决表述必须在位（防「整段删注释」式伪绿）；
//   ③ 与生产真值配对：浮动胶囊组件确已删除，PC 工具条 Panel 与空态仍在。
// 注意：本文件不新增任何布局读取点；字符串里的断点名仅用于逐字检测旧注释回潮
// （棘轮按 strip_comments 统一计数，且只统计 Shell 源码，测试文件不计入）。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, 'CanvasPage.vue'), 'utf8')
const shell = readFileSync(join(here, '..', 'components', 'mobile', 'MobileCanvasShell.vue'), 'utf8')
const mobileDir = join(here, '..', 'components', 'mobile')

describe('PR5 注释漂移防回潮（overlay-residuals spike §3）', () => {
  it('D1 壳层边界注释不得再称「胶囊包在 Panel / 两处残留留待后续」', () => {
    expect(shell).not.toContain('胶囊 MobileCanvasTopControls')
    expect(shell).not.toContain('残留留待后续定位重构')
    expect(shell).not.toContain('两处 isMobileLayout 残留')
  })

  it('D2 PC 工具条注释不得再称「由顶部胶囊接管」', () => {
    expect(page).not.toContain('顶部胶囊接管')
  })

  it('D3 画布世界注释不得再称「胶囊/空态因依赖定位暂留」', () => {
    expect(page).not.toContain('定位暂留')
    expect(page).not.toContain('VueFlow + 胶囊 + 空态')
  })

  it('有效性配对：三处裁决表述必须在位（防整段删注释式伪绿）', () => {
    expect(shell).toContain('overlay-residuals spike 裁决保留')
    expect(page).toContain('上提至 MobileTopBar，不再有浮动胶囊')
    expect(page).toContain('经 overlay-residuals spike 裁决保留')
  })

  it('真值配对：浮动胶囊组件确已删除；PC 工具条 Panel 与空态仍在', () => {
    expect(existsSync(join(mobileDir, 'MobileCanvasTopControls.vue'))).toBe(false)
    expect(page).toContain('position="bottom-right"')
    expect(page).toContain('data-testid="mobile-canvas-empty"')
  })
})
