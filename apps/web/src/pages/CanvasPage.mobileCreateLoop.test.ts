import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CP = readFileSync(join(HERE, '..', 'pages', 'CanvasPage.vue'), 'utf8')

/**
 * 移动端新建流闭环（R2-T3，2026-10-23 真机走查）。
 *
 * R1 删掉移动端 Dock 后留下断点①：`handleDockAdd` 建节点 → 选中 → 聚焦，
 * 但 PC 端「选中即开 DockStudioToolbar」，移动端 Dock 已被删 ⇒ 新节点没有任何编辑器承载。
 * 修法：移动端新建后直接打开编辑 sheet（复用 `MobileNodeEditorSheet`，Q3「create/edit 同源」）。
 *
 * ⛔ PC 路径必须零 diff（审阅焦点 #1）。
 */
describe('R2-T3 移动端新建流闭环', () => {
  it('handleDockAdd 含移动端分支，新建后打开编辑 sheet', () => {
    const body = /function handleDockAdd\(type: DockNodeType\) \{[\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(body).toContain('isMobileLayout')
    expect(body).toContain('openMobileNodeEditor')
  })

  it('provide 了 MOBILE_NODE_OPEN_EDITOR_KEY，回调复用 openMobileNodeEditor', () => {
    expect(CP).toContain('MOBILE_NODE_OPEN_EDITOR_KEY')
    const body = /provide\(MOBILE_NODE_OPEN_EDITOR_KEY[\s\S]*?\n\}\)/.exec(CP)?.[0] ?? ''
    // 复用既有 openMobileNodeEditor（它内部才设 mobileEditorNode）——
    // 守卫断言「走既有通道」而非「直接改 mobileEditorNode」，逼后续改动保持复用。
    expect(body).toContain('openMobileNodeEditor')
  })

  it('PC 路径未被触碰（handleDockAdd 的桌面行为不变：select + focus + persist）', () => {
    const body = /function handleDockAdd\(type: DockNodeType\) \{[\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    // 桌面三步仍在
    expect(body).toContain('selectOnlyNode')
    expect(body).toContain('persistUserEdit')
    expect(body).toContain('focusNodeById')
  })

  it('复用既有 openMobileNodeEditor（R1 已交付的 MobileNodeEditorSheet 通道），不新建组件', () => {
    expect(CP).toContain('function openMobileNodeEditor(nodeId: string)')
  })
})
