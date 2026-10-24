import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CP = readFileSync(join(HERE, '..', 'pages', 'CanvasPage.vue'), 'utf8')

/**
 * 移动端新建流闭环（R2-T3，2026-10-23 真机走查 → 2026-10-24 走查③修订）。
 *
 * R2-T3：R1 删掉移动端 Dock 后，`handleDockAdd` 建节点没有编辑器承载 ⇒ 当时
 * 裁决「移动端新建后直接打开编辑 sheet」。
 *
 * 走查③（2026-10-24 用户裁决）**推翻**了该权宜：新建节点不该自动弹 studio
 * dock（「创建被编辑器劫持」，且 sheet 当时没有明确的关闭入口 ⇒ 走查④⑤）。
 * 现在编辑器入口已补齐（空瓦片 CTA + tap 空瓦片即路由到编辑 sheet +
 * 编辑 sheet 右上角 X），auto-open 的存在理由消失。
 *
 * ⛔ PC 路径仍然零 diff（桌面仍靠选中开 DockStudioToolbar）。
 */
describe('移动端新建流闭环', () => {
  it('走查③：新建节点不再自动打开编辑 sheet（auto-open 已删）', () => {
    const body = /function handleDockAdd\(type: DockNodeType\) \{[\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(body, '必须能定位 handleDockAdd').not.toBe('')
    // 权宜分支已删：函数体内不得再按移动布局开编辑器
    expect(body).not.toContain('openMobileNodeEditor')
    expect(body).not.toContain('if (isMobileLayout.value) openMobileNodeEditor')
  })

  it('编辑器入口改由空瓦片承担：CTA 文案 + tap 空节点路由（替代 auto-open）', () => {
    // 空瓦片有明确的行动提示（MobileNodeTile 的 emptyCtaLabel），tap 空节点
    // 经 mobileNodeOpenPolicy 的 empty 行路由到编辑 sheet。
    const tile = readFileSync(
      join(HERE, '..', 'components', 'mobile', 'MobileNodeTile.vue'),
      'utf8',
    )
    expect(tile).toContain('emptyCtaLabel')
    expect(tile).toContain('点按撰写')
    expect(tile).toContain('点按生成')
    // 有效性配对：open 策略仍在（删除 auto-open 不等于没有入口）
    const policy = readFileSync(
      join(HERE, '..', 'composables', 'mobileNodeOpenPolicy.ts'),
      'utf8',
    )
    expect(policy).toContain('empty')
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
