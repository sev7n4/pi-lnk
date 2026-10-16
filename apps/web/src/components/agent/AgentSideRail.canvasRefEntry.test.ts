// P1-2.3 画布节点引用一等公民（Task 6）：
// hover-only 球（composer-canvas-pick-btn）全量退役，角落 ghost 入口（composer-canvas-ref-btn）上位。
// 注：brief 里的 `__dirname` 在 vitest ESM 下不存在，这里用 fileURLToPath(import.meta.url)。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

describe('canvas ref entry as first-class citizen (P1-2.3)', () => {
  it('legacy hover ball is fully removed (paired with new-entry presence)', () => {
    expect(sfc).not.toContain('从画布选节点作引用')          // 旧 aria-label
    expect(sfc).not.toContain('composer-canvas-pick-btn')   // 旧类名（含 halo/lens 派生）
    expect(sfc).toContain('aria-label="引用画布节点"')       // 新入口存在
    expect(sfc).toContain('composer-canvas-ref-btn')
  })
  it('ghost: corner button has no glass background, anchored at vertex', () => {
    const rule = sfc.match(/\.composer-canvas-ref-btn\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).not.toContain('--neo-glass')
    expect(rule).toContain('background: transparent')
    expect(rule).toContain('translate(-50%, -50%)')
    expect(rule).toContain('width: 22px')
  })
  it('visibility gated: hidden in idle, visible in input/generating', () => {
    // 明确符号断言（比脆弱的位置正则更稳）：computed 名 + 模板绑定
    expect(sfc).toContain('canvasRefEntryVisible')
    expect(sfc).toMatch(/v-if="[^"]*canvasRefEntryVisible[^"]*"/)
  })
  it('C drawer does not contain canvas pick (only the corner button calls the toggle)', () => {
    expect(sfc.match(/onCanvasRefPickToggle/g)?.length).toBe(1)
  })
})
