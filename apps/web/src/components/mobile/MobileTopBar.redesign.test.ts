// 规格 §6.2 / §6.3（mobile-web-three-page-topbar-redesign）：对话/画布顶栏同构——
// ‹ 返回创作空间 + 项目名(§6.4) + ⋯；画布额外 ⤢ 适应画布。去掉 open-drawer / go-home /
// new-chat / open-history / 品牌字标回城等冗余回城与入口。
// 静态契约（jsdom 不计算样式；同 CanvasPage.mobileChromeHygiene.test.ts 模式）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const topBar = readFileSync(join(here, 'MobileTopBar.vue'), 'utf8')

/** 剥注释后再断言「某物已移除」——迁移记录写在注释里是规范（棘轮同款教训）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('MobileTopBar 对话/画布同构（三页顶栏重构）', () => {
  const code = stripComments(topBar)

  it('返回 + 项目名 + ⋯ 三件齐备（chat / canvas 共用）', () => {
    expect(code).toContain('data-testid="mobile-topbar-back"')
    expect(code).toContain('data-testid="mobile-topbar-project-name"')
    expect(code).toContain('data-testid="mobile-topbar-menu"')
    // 返回簇文案 = 创作空间
    expect(code).toContain('返回创作空间')
    // 项目名走 props（由壳层透传 sessionTitle）
    expect(code).toContain('projectName: string')
  })

  it('画布分支额外 ⤢ 适应画布（桥接 VueFlow fitView）', () => {
    expect(code).toContain('data-testid="mobile-topbar-fit"')
    expect(code).toContain('适应画布')
    expect(code).toContain("emit('fit-view')")
  })

  it('冗余回城/入口已退役：open-drawer / go-home / new-chat / open-history 零命中', () => {
    expect(code).not.toContain('open-drawer')
    expect(code).not.toContain('go-home')
    expect(code).not.toContain('new-chat')
    expect(code).not.toContain('open-history')
  })

  it('项目名样式（§6.4 → §13.5 v2 居中题注）：细体小字、次级灰、绝对居中、超长截断、非交互', () => {
    const block = stripComments(topBar)
    expect(block).toContain('var(--lnk-text-secondary)')
    expect(block).toContain('text-overflow: ellipsis')
    // 居中：left 50% + translateX，不随左右簇宽度漂移
    expect(block).toMatch(/\.topbar-page-title\s*\{[\s\S]{0,400}?left:\s*50%/)
    expect(block).toMatch(/\.topbar-page-title\s*\{[\s\S]{0,400}?transform:\s*translateX\(-50%\)/)
    // 细体小字：12px + 300（§13.5：上下文标签不抢占视觉）
    expect(block).toMatch(/\.topbar-page-title\s*\{[\s\S]{0,400}?font-size:\s*12px/)
    expect(block).toMatch(/\.topbar-page-title\s*\{[\s\S]{0,400}?font-weight:\s*300/)
    expect(block).toContain('pointer-events: none')
  })

  it('页题注文案（§13.5）：「对话·「项目名称」」/「画布·「项目名称」」', () => {
    expect(code).toContain("props.tab === 'canvas' ? '画布' : '对话'")
    expect(code).toContain('${label}·「${props.projectName}」')
  })

  it('画布页签去封条（§13.5）：is-canvas-bare 透明化，对话页签保留材质（内容穿栏）', () => {
    expect(code).toMatch(/\.mobile-top-bar\.is-canvas-bare\s*\{[\s\S]{0,300}?background:\s*transparent/)
    expect(code).toMatch(/\.mobile-top-bar\.is-canvas-bare\s*\{[\s\S]{0,300}?backdrop-filter:\s*none/)
    // 对话页签材质保留（基础栏仍持 bg+blur）——对话流 padding-top 16px < 栏高
    expect(code).toMatch(/\.mobile-top-bar\s*\{[\s\S]{0,500}?background:\s*var\(--lnk-surface-overlay\)/)
  })
})
