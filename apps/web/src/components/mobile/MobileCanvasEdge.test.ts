import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// SP-F Q1 契约（spec 2026-10-28-canvas-edge-remedy-loop-design.md §3.1 / V-1 / V-2）。
// ⚠️ CSS 不能走 `?raw`（本环境实测返回空串，见 AgentNodeGraph.test.ts:85 注释）⇒ 用 fs 读。

// vitest root = apps/web ⇒ cwd 即 web 根（import.meta.url 在 vite 管道下会变 /@fs/ 且拼丢斜杠）
const WEB_ROOT = `${process.cwd()}/`

describe('MobileCanvasEdge（SP-F Q1 契约）', () => {
  const css = readFileSync(`${WEB_ROOT}src/components/mobile/MobileCanvasEdge.css`, 'utf8')
  const tokens = readFileSync(`${WEB_ROOT}src/styles/design-tokens.css`, 'utf8')
  const shell = readFileSync(`${WEB_ROOT}src/components/mobile/MobileCanvasShell.vue`, 'utf8')

  it('规则被 ≤767px media query 包裹（桌面零回归，Review Focus #5）', () => {
    const block = css.match(/@media \(max-width: 767px\)\s*\{[\s\S]*\}/)?.[0] ?? ''
    expect(block).toContain('.vue-flow__edge-path')
    expect(block).toContain('stroke-width: var(--canvas-edge-width, 2px)')
  })

  it('消费 L2 令牌且保留用户显式 edgeColor 优先（Review Focus #2）；禁新增 rgba 字面量', () => {
    expect(css).toContain('var(--canvas-edge-color, var(--lnk-canvas-edge-strong))')
    expect(css).not.toMatch(/rgba\(/)
  })

  it('width 走 var 回退（评审 Important#1：用户显式 edgeWidth 在移动端仍生效）', () => {
    expect(css).toContain('stroke-width: var(--canvas-edge-width, 2px)')
    // CanvasPage 改为条件注入：仅用户改过默认 1.5 才写 --canvas-edge-width
    const page = readFileSync(`${WEB_ROOT}src/pages/CanvasPage.vue`, 'utf8')
    expect(page).toContain("s.edgeWidth !== DEFAULT_EDGE_WIDTH")
  })

  it('状态高亮边（selected/upstream/downstream）不被兜底抢占（评审 Important#2）', () => {
    expect(css).toContain(':not(.selected):not(.neo-edge-upstream):not(.neo-edge-downstream)')
  })

  it('令牌在 design-tokens.css 深浅两块同名成对（V-2）', () => {
    const dark = tokens.match(/:root\[data-theme='dark'\]\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    const light = tokens.match(/:root\[data-theme='light'\]\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(dark).toContain('--lnk-canvas-edge-strong:')
    expect(light).toContain('--lnk-canvas-edge-strong:')
  })

  it('壳层导入本样式（AGENTS.md 移动端规则 1：编排唯一所有者是壳层）', () => {
    expect(shell).toContain("import './MobileCanvasEdge.css'")
  })
})
