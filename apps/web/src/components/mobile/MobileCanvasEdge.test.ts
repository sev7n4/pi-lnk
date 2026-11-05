import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// SP-F Q1 契约（spec 2026-10-28-canvas-edge-remedy-loop-design.md §3.1 / V-1 / V-2）。
// ⚠️ CSS 不能走 `?raw`（本环境实测返回空串，见 AgentNodeGraph.test.ts:85 注释）⇒ 用 fs 读。

// vitest root = apps/web ⇒ cwd 即 web 根（import.meta.url 在 vite 管道下会变 /@fs/ 且拼丢斜杠）
const WEB_ROOT = `${process.cwd()}/`

describe('画布连线可见性契约（SP-F Q1 + 2026-11-05 双端根治）', () => {
  const css = readFileSync(`${WEB_ROOT}src/components/mobile/MobileCanvasEdge.css`, 'utf8')
  const globalCss = readFileSync(`${WEB_ROOT}src/styles/neo-node.css`, 'utf8')
  const tokens = readFileSync(`${WEB_ROOT}src/styles/design-tokens.css`, 'utf8')
  const shell = readFileSync(`${WEB_ROOT}src/components/mobile/MobileCanvasShell.vue`, 'utf8')

  it('规则被 ≤767px media query 包裹（桌面零回归，Review Focus #5）', () => {
    const block = css.match(/@media \(max-width: 767px\)\s*\{[\s\S]*\}/)?.[0] ?? ''
    expect(block).toContain('.vue-flow__edge-path')
    expect(block).toContain('stroke-width: var(--canvas-edge-width, 2.5px)')
  })

  it('消费 L2 令牌且保留用户显式 edgeColor 优先（Review Focus #2）；禁新增 rgba 字面量', () => {
    expect(css).toContain('var(--canvas-edge-color, var(--lnk-canvas-edge-strong))')
    expect(css).not.toMatch(/rgba\(/)
  })

  it('width 走 var 回退（评审 Important#1：用户显式 edgeWidth 在移动端仍生效）', () => {
    expect(css).toContain('stroke-width: var(--canvas-edge-width, 2.5px)')
    // CanvasPage 改为条件注入：仅用户改过默认 1.5 才写 --canvas-edge-width
    const page = readFileSync(`${WEB_ROOT}src/pages/CanvasPage.vue`, 'utf8')
    expect(page).toContain("s.edgeWidth !== DEFAULT_EDGE_WIDTH")
  })

  // ⭐ 2026-11-05：PC 端也纳入范围。生产取证「13 条边全落库、端点全有效」⇒
  // 症状是渲染层视觉不可见，而非数据丢失。桌面此前被 SP-F 规格明确排除，
  // 只用 --neo-edge(alpha .3/.22) + 1.5px + fitView 缩放 ⇒ 亚像素淡线。
  it('全局基线改用强边令牌，不再回退到淡色 --neo-edge（PC 可见性 P0）', () => {
    const rule = /\.vue-flow__edge \.vue-flow__edge-path\s*\{([^}]*)\}/.exec(globalCss)?.[1] ?? ''
    expect(rule).toContain('var(--lnk-canvas-edge-strong')
    expect(rule).toContain('stroke-width: var(--canvas-edge-width, 2.5px)')
    expect(rule).not.toContain('var(--canvas-edge-color, var(--neo-edge))')
    // 用户显式 edgeColor 仍须保持第一优先级
    expect(rule).toContain('var(--canvas-edge-color,')
  })

  it('全局基线带 non-scaling-stroke：fitView 缩放不得把线压成亚像素（根因级）', () => {
    const rule = /\.vue-flow__edge \.vue-flow__edge-path\s*\{([^}]*)\}/.exec(globalCss)?.[1] ?? ''
    expect(rule).toContain('vector-effect: non-scaling-stroke')
    expect(rule).toContain('stroke-linecap: round')
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
