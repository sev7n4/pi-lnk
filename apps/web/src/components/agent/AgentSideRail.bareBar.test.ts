// P1-5 移动端底部裸条（Task 10）：全屏 sheet + 遮罩 + 「看画布」退回按钮退役，
// 三态共条（idle / stacked / queued）。fs-scan 断言配对有效性（否定断言必配肯定断言）。
// 注：brief 里的 `__dirname` 在 vitest ESM 下不存在，这里用 fileURLToPath(import.meta.url)。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

describe('mobile bare bar structure (P1-5)', () => {
  it('full-screen backdrop + view-canvas escape removed (paired with bar presence)', () => {
    // 真实类名已核实：遮罩 = agent-mobile-backdrop；退回按钮 = agent-view-canvas-btn
    expect(sfc).not.toContain('agent-mobile-backdrop')
    expect(sfc).not.toContain('agent-view-canvas-btn')
    expect(sfc).toContain('composer-bare-bar')
  })
  it('idle bar: ＋ inside the bar, no separate control row', () => {
    expect(sfc).toMatch(/composer-bare-bar[\s\S]{0,600}aria-label="更多"/)
    expect(sfc).toMatch(/按住说话/)
  })
  it('status line & interject options live ABOVE the bar (system layer)', () => {
    expect(sfc).toMatch(/composer-status-line[\s\S]{0,400}composer-bare-bar/)
  })
  it('pure module contract: barShape routes the three bar shapes', () => {
    // 有效性断言：模板消费 mobileBarLayout 的 barShape（防空集假绿——类名存在但没接线）
    expect(sfc).toContain("from './composer/mobileBarLayout'")
    expect(sfc).toMatch(/barShape\(\{/)
  })
})
