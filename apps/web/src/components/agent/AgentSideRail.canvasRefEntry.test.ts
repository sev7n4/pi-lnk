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
  it('corner button is a bare badge (no gray disc) anchored at vertex, lit on active', () => {
    const rule = sfc.match(/\.composer-canvas-ref-btn\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).not.toContain('--neo-glass')
    // 2026-11-09 用户裁定：撤销中灰盘，直接出 anchor-badge.png 裸徽标（与 SSE 轮次抬头同源）
    expect(rule).toContain('background: transparent')
    expect(rule).not.toContain('color-mix(in srgb, var(--lnk-text-muted) 60%')
    expect(rule).toContain('var(--lnk-hi-text)')
    expect(rule).toContain('translate(-65%, -65%)')
    expect(rule).toContain('width: 22px')
    // 激活（pick 模式）= 徽标下垫 hi-bg 盘 + 辉光（裸徽标仍浮于其上）
    expect(sfc).toMatch(/\.composer-canvas-ref-btn\.is-active\s*\{[^}]*var\(--lnk-hi-bg\)/)
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
