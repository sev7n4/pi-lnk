import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Task 5：用量面板与账户卡的表面语言统一守卫。
 *
 * 背景：UsagePanel 的骨架屏用 `--lnk-surface-sunken` + `--lnk-radius-xl`，
 * 而热力图/趋势/日表都是 `--lnk-surface-canvas` + `rounded-2xl`（24px）。
 * 加载态与真卡在暗色下会"跳色"、切换时卡片形状也变了。
 *
 * 这是纯样式契约，用读源码断言而非 mount —— 断言挂载后的计算样式需要
 * 真实 CSS 注入，jsdom 给不出。
 */
const here = dirname(fileURLToPath(import.meta.url))
const read = (name: string) => readFileSync(join(here, name), 'utf8')

describe('UsagePanel 卡片语言统一（Task 5）', () => {
  it('骨架屏与错误态用同一张卡语言：surface-canvas + radius-2xl + border-subtle', () => {
    const src = read('UsagePanel.vue')

    // 骨架屏：凹陷面改为卡片面
    expect(src).toContain('background: var(--lnk-surface-canvas);')
    expect(src).not.toContain('background: var(--lnk-surface-sunken);')
    // 骨架屏补上边框，与真卡的 border-overlay/8 等价
    expect(src).toContain('border: 1px solid var(--lnk-border-subtle);')
    // 骨架屏与错误态统一圆角档
    expect(src).not.toContain('border-radius: var(--lnk-radius-xl);')
    expect(src).toContain('border-radius: var(--lnk-radius-2xl);')
  })

  it('总览小卡与热力图/趋势/日表同圆角档（不再用 rounded-xl）', () => {
    const overview = read('UsageOverviewCards.vue')
    expect(overview).toContain('rounded-2xl border border-overlay/8 bg-surface-canvas')
    expect(overview).not.toContain('rounded-xl')
  })

  it('同族卡片圆角档一致：热力图/趋势/日表都是 rounded-2xl', () => {
    for (const f of ['UsageHeatmap.vue', 'UsageTrend.vue', 'UsageDayTable.vue']) {
      expect(read(f)).toContain('rounded-2xl border border-overlay/8 bg-surface-canvas')
    }
  })
})
