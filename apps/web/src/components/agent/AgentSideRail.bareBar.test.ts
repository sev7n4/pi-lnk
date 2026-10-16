// P1-5 移动端底部裸条（Task 10 + fix-1）：全屏 sheet + 遮罩 + 「看画布」退回按钮退役，
// 三态共条（idle / stacked / queued）。fs-scan 断言配对有效性（否定断言必配肯定断言）。
// fix-1（F2）：距离/位置断言一律在「切出模板区 + 剥离 HTML 注释」后的文本上做 indexOf
// 顺序断言——注释锚（comment anchor）会让位置正则空转成假绿。
// 注：brief 里的 `__dirname` 在 vitest ESM 下不存在，这里用 fileURLToPath(import.meta.url)。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

/** 根模板区（首个 <template> 到最后一个 </template>）+ 剥离 HTML 注释（含触发注释锚的历史记录） */
const tpl = sfc
  .slice(sfc.indexOf('<template>'), sfc.lastIndexOf('</template>'))
  .replace(/<!--[\s\S]*?-->/g, '')

describe('mobile bare bar structure (P1-5)', () => {
  it('full-screen backdrop + view-canvas escape removed (paired with bar presence)', () => {
    // 真实类名已核实：遮罩 = agent-mobile-backdrop；退回按钮 = agent-view-canvas-btn
    expect(sfc).not.toContain('agent-mobile-backdrop')
    expect(sfc).not.toContain('agent-view-canvas-btn')
    expect(tpl).toContain('composer-bare-bar')
  })
  it('idle bar: ＋ inside the bar (order: bar surface before its ＋ control), hint present', () => {
    // 存在性配对（防空集假绿）+ 顺序断言（条表面在先、条内 ＋ 在后）
    expect(tpl).toContain('composer-bare-bar')
    expect(tpl).toContain('aria-label="更多"')
    expect(tpl).toContain('按住说话')
    expect(tpl.indexOf('composer-bare-bar')).toBeLessThan(tpl.indexOf('aria-label="更多"'))
  })
  it('status line & interject options live ABOVE the bar (system layer)', () => {
    // 存在性配对 + 顺序断言（状态行模板位置在 composer-bare-bar 之前）
    expect(tpl).toContain('class="composer-status-line"')
    expect(tpl).toContain('composer-bare-bar')
    expect(tpl.indexOf('class="composer-status-line"')).toBeLessThan(tpl.indexOf('composer-bare-bar'))
  })
  it('pure module contract: barShape routes the three bar shapes', () => {
    // 有效性断言：mobileBarLayout 的 barShape 被组件消费（防空集假绿——类名存在但没接线）；
    // barShape 调用点在 script（computed），故断言对象是 sfc 而非 tpl
    expect(sfc).toContain("from './composer/mobileBarLayout'")
    expect(sfc).toContain('barShape({ hasRefs:')
  })
})
