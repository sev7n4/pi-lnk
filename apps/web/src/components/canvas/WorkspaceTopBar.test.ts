// 规格 §6.8（mobile-web-three-page-topbar-redesign）：WEB 工作台统一顶栏。
// ① WorkspaceTopBar 结构：‹ 返回创作空间 + 项目名(§6.4) + 发现/主题/账号
//    （v3 §13.4：「我的」撤除——与头像下拉「我的主页」重复，头像即个人枢纽）；
//    ⚠️ 2026-10-30：右上「...」项目操作菜单（保存画布/发布作品/导入导出工作流）
//    整体移除（用户裁决），入口后续统一重新规划；
// ② AgentSideRail 头部已退役「新对话 / 历史」入口（ADR-0015 统一单对话模型），
//    仅保留浮动窗口切换与「收起助手」。
// 静态契约（jsdom 不计算样式；同 CanvasPage.mobileChromeHygiene.test.ts 模式）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const readComp = (p: string) => readFileSync(join(here, '..', p), 'utf8')
const topBar = readComp('canvas/WorkspaceTopBar.vue')
const agentRail = readComp('agent/AgentSideRail.vue')

/** 剥注释后再断言「某物已移除」——迁移记录写在注释里是规范（棘轮同款教训）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('WorkspaceTopBar（WEB 工作台顶栏）', () => {
  it('结构：‹ 返回创作空间 + 项目名 + 发现/主题/账号（v3：无「我的」）', () => {
    expect(topBar).toContain('data-testid="workspace-back"')
    expect(topBar).toContain('data-testid="workspace-project-name"')
    expect(topBar).toContain('data-testid="workspace-discover"') // 发现 → /community（画廊不加发现的拍板下，顶栏是 PC 唯一可达点）
    // v3 §13.4/D1：「我的」撤除（语义由 AccountChrome→AccountUserMenu「我的主页」承载）
    expect(topBar).not.toContain('data-testid="workspace-mine"')
    expect(stripComments(topBar)).not.toContain("to=\"/profile\"")
    // 主题/账号入口收进顶栏（替代原画布右上漂浮簇）
    expect(topBar).toContain('<ThemeToggle')
    expect(topBar).toContain('<AccountChrome')
    // 返回簇文案 = 创作空间
    expect(topBar).toContain('创作空间')
  })

  it('2026-10-30 收敛：⋯ 项目操作菜单整体移除（保存/发布/导入/导出 不再由顶栏承载）', () => {
    const block = stripComments(topBar)
    // 菜单与全部菜单项退场（防空集假绿：有效性配对见上——顶栏仍有 发现/主题/账号 真实入口）
    expect(topBar).not.toContain('data-testid="workspace-menu"')
    expect(block).not.toContain('保存画布')
    expect(block).not.toContain('发布作品')
    expect(block).not.toContain('导入工作流')
    expect(block).not.toContain('导出工作流')
    expect(block).not.toContain('轻量包（不含媒体）')
    // 对应 emits 一并下线，防死 emit 残留
    expect(block).not.toContain('save: []')
    expect(block).not.toContain('publish: []')
    expect(block).not.toContain("'import-workflow': []")
    expect(block).not.toContain("'export-workflow': []")
    expect(block).not.toContain("'export-workflow-light': []")
    expect(block).not.toContain('menuOpen')
  })

  it('§13.5（真机走查四轮）：封条彻底退役——栏体透明、材质/blur 全去', () => {
    const block = stripComments(topBar)
    expect(block).not.toContain('border-bottom')
    expect(block).toMatch(/\.workspace-top-bar\s*\{[\s\S]{0,500}?background:\s*transparent/)
    // 封条退役后 blur 一并去掉（画布节点穿栏时与画布同底，用户裁决视觉不抢占）
    expect(block).not.toContain('backdrop-filter')
  })

  it('居中页题注（§13.5 v2）：「画布·「项目名称」」，细体小字、绝对居中、超长截断、非交互', () => {
    const block = stripComments(topBar)
    expect(block).toContain('画布·「{{ projectName }}」')
    expect(block).toMatch(/\.wkb-page-title\s*\{[\s\S]{0,400}?left:\s*50%/)
    expect(block).toMatch(/\.wkb-page-title\s*\{[\s\S]{0,400}?transform:\s*translateX\(-50%\)/)
    expect(block).toMatch(/\.wkb-page-title\s*\{[\s\S]{0,400}?font-size:\s*13px/)
    expect(block).toMatch(/\.wkb-page-title\s*\{[\s\S]{0,400}?font-weight:\s*300/)
    expect(block).toContain('var(--lnk-text-secondary')
    expect(block).toContain('text-overflow: ellipsis')
    expect(block).toContain('pointer-events: none')
  })
})

describe('AgentSideRail 头部入口收敛（ADR-0015）', () => {
  it('头部已退役「新对话 / 历史」按钮（统一单对话，建/切对话收口到创作空间与移动端顶栏）', () => {
    // 精确命中被删按钮的 title 属性（toast/注释里的「新对话/对话历史」字样不计）
    expect(agentRail).not.toContain('title="新对话"')
    expect(agentRail).not.toContain('title="对话历史"')
  })

  it('仍保留浮动窗口切换与「收起助手」', () => {
    const block = stripComments(agentRail)
    expect(block).toContain('切换为浮动窗口')
    expect(block).toContain('收起助手')
  })
})
