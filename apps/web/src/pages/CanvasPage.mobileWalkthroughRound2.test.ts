// 移动端画布真机走查第二轮（2026-10-21）的静态契约。
// 背景：本轮 4 条真机反馈全部落在「jsdom 看不见」的那一类——视口高度、层叠、
// 选区语义、能力探测。⇒ 用源码静态契约把判据钉死，防回潮。
// 判据写法沿用本仓既有纪律：否定断言先剥注释 + 限定作用域 + 配有效性断言。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')
const readComponent = (p: string) => readFileSync(join(here, '..', 'components', p), 'utf8')
const readStyle = (p: string) => readFileSync(join(here, '..', 'styles', p), 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('多选累加（2026-10-21 真机：长按第二张图 ⇒ 第一张被取消）', () => {
  const page = read('./CanvasPage.vue')

  it('已在多选态时，长按的节点是「加入/移出」而不是重置整份选区', () => {
    const fn = page.match(/function enterMultiSelectMode\([\s\S]*?\n}/)?.[0] ?? ''
    expect(fn, '必须能定位 enterMultiSelectMode').not.toBe('')
    // 先判多选态 → toggle（累加），否则才以该节点为种子进入
    expect(fn).toMatch(/mobileMultiSelectActive\.value\s*\)[\s\S]*?toggleNodeInMultiSelect\(seedId\)/)
    // 种子路径仍只走一次（进入多选态）
    expect(fn).toMatch(/selectNodeIds\(\[seedId\]\)/)
    // 有效性配对：toggle 实现确实按「已在选区内则移除」语义
    const toggle = page.match(/function toggleNodeInMultiSelect\([\s\S]*?\n}/)?.[0] ?? ''
    expect(toggle).toMatch(/set\.has\(id\)\)\s*set\.delete\(id\)/)
    expect(toggle).toMatch(/else set\.add\(id\)/)
  })

  it('上下文 sheet 的「多选」文案随态变化（多选 / 加入多选 / 移出多选）', () => {
    const menu = readComponent('canvas/CanvasContextMenu.vue')
    expect(menu).toContain('multiSelectActive')
    expect(menu).toContain("return '多选'")
    expect(menu).toContain("'加入多选'")
    expect(menu).toContain("'移出多选'")
    // 接线：页面把多选态与「该节点是否在选区内」传下去
    expect(page).toContain(':multi-select-active="mobileMultiSelectActive"')
    expect(page).toContain(':multi-select-selected=')
  })
})

describe('移动端 studio dock 默认折叠（2026-10-21 用户裁决：创建节点不再自动弹）', () => {
  const page = stripComments(read('./CanvasPage.vue'))
  const toolbar = readComponent('canvas/DockStudioToolbar.vue')

  it('移动端 collapsed 恒真（tap 把手展开），PC 判据不变', () => {
    expect(page).toContain(':collapsed="dockCollapsedByOverlay || isMobileLayout"')
    // 有效性配对：PC 的浮层收缩判据仍在
    expect(page).toContain('dockCollapsedByOverlay')
  })

  it('dock 展开态由 tap 通道向上回报（底部元素据此让位）', () => {
    expect(toolbar).toContain("collapseChange: [expanded: boolean]")
    expect(toolbar).toContain('watch(tapOpen')
    expect(page).toContain('@collapse-change="mobileDockExpanded = $event"')
    expect(page).toContain(':dock-expanded="mobileDockExpanded"')
  })

  it('dock 展开判据 = 实际展开（不再用「有选中节点」）', () => {
    const open = page.match(/const mobileStudioDockOpen = computed\([\s\S]*?\n\)/)?.[0] ?? ''
    expect(open).toContain('mobileDockExpanded.value')
    expect(open).not.toContain('editorNode.value')
  })

  it('dock 展开时 ＋FAB 让位（不压在面板左下角）', () => {
    const shell = readComponent('mobile/MobileCanvasShell.vue')
    expect(shell).toContain('!dockExpanded')
  })
})

describe('底部锚定元素落位（2026-10-21 真机：＋FAB 被裸条盖掉一半）', () => {
  const fab = readComponent('mobile/MobileCanvasCreateFab.vue')
  const rail = readComponent('agent/AgentSideRail.vue')
  const railCode = stripComments(rail)
  const page = read('./CanvasPage.vue')

  it('＋FAB 不再依赖运行时测量变量（落位恒定，与 composer 条同基线）', () => {
    // ⚠️ 先剥 CSS 注释：迁移说明写在注释里是规范（否定断言命中注释 = 假红）
    const css = stripComments(fab).match(/\.mobile-create-fab \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(css, '必须能定位 FAB 样式块').not.toBe('')
    expect(css).toContain('var(--lnk-tabbar-h')
    expect(css).not.toContain('--lnk-agent-dock-h')
    expect(css).toContain('left: 12px')
  })

  it('窗态由 composer 盖住 ＋FAB：裸条保持原宽、FAB 由 composerVisible 门控', () => {
    // 2026-10-21 真机走查②：上一轮「裸条左移 56px 与 FAB 并排 + 空闲态隐藏条内 ＋」
    // 已撤销——用户裁决：composer 不得让位变形；窗态里 FAB 本就不可用（输入会切对话页），
    // 由 composer 盖住这一带（尺寸计算见 MobileCanvasCreateFab 的注释：48=48 无内缩余量）。
    expect(railCode).not.toMatch(/\.is-canvas-view \.composer-bare-bar\s*\{/)
    expect(railCode).not.toMatch(/\.is-canvas-view \.composer-bare-bar\.is-idle \.agent-attach-menu/)
    expect(rail).not.toContain('margin-left: 56px')
    // 有效性配对：FAB 门控含窗态判据，且判据与 composer 收起条件同源
    const shell = readComponent('mobile/MobileCanvasShell.vue')
    expect(shell).toMatch(/<MobileCanvasCreateFab[\s\S]*?!composerVisible/)
    expect(page).toContain('const mobileCanvasComposerVisible = computed(')
    expect(page).toContain('!mobileCanvasImm.value')
    expect(page).toContain(':composer-visible="mobileCanvasComposerVisible"')
  })

  it('已在画布视图内定位不改入口语义（＋建节点不该把纯画布切成窗态）', () => {
    const fn = page.match(/async function focusNodeById\([\s\S]*?\n}/)?.[0] ?? ''
    expect(fn, '必须能定位 focusNodeById').not.toBe('')
    expect(fn).toContain('const enteringFromConversation = !mobileCanvasView.value')
    expect(fn).toMatch(/mobileCanvasImm\.value\s*=\s*enteringFromConversation[\s\S]*?:\s*mobileCanvasImm\.value/)
    // 有效性配对：从对话页进入时仍按待确认判据决定 imm（ADR-0011 T6 未被削弱）
    expect(fn).toContain('isPendingConfirmNode(')
    // 批量定位同规则
    const batch = page.match(/async function focusNodesByIds\([\s\S]*?\n}/)?.[0] ?? ''
    expect(batch).toContain('const enteringFromConversation = !mobileCanvasView.value')
  })

  it('--lnk-agent-dock-h 发布源改为实测裸条（贴底容器高度在画布视图不可靠）', () => {
    expect(rail).toContain('bareBarRef')
    expect(railCode).toContain('mobileDockRO.observe(bareBarRef.value)')
    // 有效性配对：裸条元素确实挂了 ref
    expect(rail).toMatch(/ref="bareBarRef"/)
  })
})

describe('语音能力诚实化（2026-10-21 真机：按住说话不可用且零反馈）', () => {
  const rail = readComponent('agent/AgentSideRail.vue')
  const speech = read('./../composables/useSpeechRecognition.ts')

  it('空闲条文案按能力降级（不支持时不承诺「按住说话」）', () => {
    expect(rail).toContain('mobileBarIdleHint')
    expect(rail).toMatch(/speech\.supported\s*\?\s*'按住说话 · 点按输入'\s*:\s*'点按输入'/)
    expect(rail).toContain('{{ mobileBarIdleHint }}')
  })

  it('识别失败必须可见（onerror 不再静默 stop）', () => {
    expect(speech).toContain('lastError')
    expect(speech).toContain('errorText')
    expect(speech).toMatch(/onerror = \(event\)[\s\S]*?lastError\.value/)
    // 有效性配对：页面把错误提示出来
    expect(rail).toContain('speech.errorText.value')
    expect(rail).toMatch(/ElMessage\.warning\(text\)/)
  })
})

describe('移动端 dock 面板布局（2026-10-21 真机：底行被挤压 / 面板过高）', () => {
  const css = readStyle('neo-node.css')

  it('底行：模型选择器可收缩，右侧动作组不收缩（发送钮不再被裁）', () => {
    const block = css.match(/@media \(max-width: 767px\) \{[\s\S]*?\.bottom-toolbar-actions \.ml-auto \{[^}]*\}/)?.[0] ?? ''
    expect(block, '必须能定位移动端底行规则').not.toBe('')
    expect(block).toMatch(/\.bottom-toolbar-actions > \*:first-child \{[^}]*flex: 1 1 120px/)
    expect(block).toMatch(/\.bottom-toolbar-actions \.ml-auto \{[^}]*flex-shrink: 0/)
  })

  it('面板：移动端提示词输入区收到 56/132（不再顶到屏顶）', () => {
    const block = css.match(/@media \(max-width: 767px\) \{[\s\S]*?\.mention-input-ghost \{[^}]*\}/)?.[0] ?? ''
    expect(block, '必须能定位移动端输入区规则').not.toBe('')
    expect(block).toContain('min-height: 56px !important')
    expect(block).toContain('max-height: 132px !important')
  })
})
