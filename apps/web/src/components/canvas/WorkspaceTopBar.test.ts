// 规格 §6.8（mobile-web-three-page-topbar-redesign）：WEB 工作台统一顶栏。
// ① WorkspaceTopBar 结构：‹ 返回创作空间 + 项目名(§6.4) + 发现/我的/主题/账号/⋯；
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
  it('结构：‹ 返回创作空间 + 项目名 + 发现/我的/主题/账号/⋯', () => {
    expect(topBar).toContain('data-testid="workspace-back"')
    expect(topBar).toContain('data-testid="workspace-project-name"')
    expect(topBar).toContain('data-testid="workspace-discover"') // 发现 → /community
    expect(topBar).toContain('data-testid="workspace-mine"') // 我的 → /profile
    expect(topBar).toContain('data-testid="workspace-menu"') // ⋯ 项目菜单
    // 主题/账号入口收进顶栏（替代原画布右上漂浮簇）
    expect(topBar).toContain('<ThemeToggle')
    expect(topBar).toContain('<AccountChrome')
    // 返回簇文案 = 创作空间
    expect(topBar).toContain('创作空间')
  })

  it('项目名样式（§6.4）：次级灰、超长截断、非交互', () => {
    const block = stripComments(topBar)
    expect(block).toContain('var(--lnk-text-secondary')
    expect(block).toContain('text-overflow: ellipsis')
    // 截断上限：不让项目名抢占视觉
    expect(block).toMatch(/max-width:\s*calc\(100% - 1[0-9][0-9]px\)/)
  })

  it('菜单含发布 / 导出（含轻量包二级）/ 导入，与移动端同构', () => {
    const block = stripComments(topBar)
    expect(block).toContain('保存画布')
    expect(block).toContain('发布作品')
    expect(block).toContain('导入工作流')
    expect(block).toContain('导出工作流')
    expect(block).toContain('轻量包（不含媒体）')
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
