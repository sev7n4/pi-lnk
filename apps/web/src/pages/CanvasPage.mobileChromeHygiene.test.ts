// 移动端画布视觉与卫生（2026-10-20 PR4 / I-8 / V-1）：
// ① 视口胶囊令牌全量 --lnk-*（旧体系棘轮只减不增）+ 小地图 160×104 + 同源持久化接线；
// ② 自动保存状态行存在，且顶栏 ⋯ 菜单不再有「保存画布」；
// ③ ⋯ 菜单按频次重排 + 导出带二级（轻量包）；
// ④ 三个零引用死代码文件确已删除。
// jsdom 不计算样式 ⇒ 令牌与尺寸走源码静态契约（同 hitTarget.test.ts 模式）。
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileSaveStatus from '@/components/mobile/MobileSaveStatus.vue'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')
const readComponent = (p: string) => readFileSync(join(here, '..', 'components', p), 'utf8')

/** 剥注释后再断言「某物已移除」——迁移记录写在注释里是规范（棘轮同款教训）：
 *  全文扫描断言必假红，否定断言要配有效性断言。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('PR4 视觉与卫生（移动端画布）', () => {
  const page = read('./CanvasPage.vue')
  const topControls = readComponent('canvas/MobileCanvasTopControls.vue')
  const topBar = readComponent('mobile/MobileTopBar.vue')
  // PR5（D-9）：移动端导航/面板/状态/入口层收敛到 MobileCanvasShell 单一壳层，
  // 以下「移动端子组件接线」断言改读壳层源码（CanvasPage 仅委托该壳层）。
  const shell = readComponent('mobile/MobileCanvasShell.vue')

  it('视口胶囊：零 --neo-*，小地图 160×104，遮罩走 accent 令牌', () => {
    expect(topControls).not.toContain('--neo-')
    expect(topControls).toContain('var(--lnk-surface-overlay)')
    expect(topControls).toContain('var(--lnk-border-subtle)')
    expect(topControls).toContain('var(--lnk-accent-subtle)')
    expect(topControls).toMatch(/width:\s*160px/)
    expect(topControls).toMatch(/height:\s*104px/)
    // 旧的 132×88 不得残留
    expect(topControls).not.toMatch(/width:\s*132px/)
  })

  it('小地图开关与 PC 同源（画布设置 minimapExpanded），不用组件本地态', () => {
    expect(topControls).toContain("emit('toggle-minimap')")
    expect(topControls).not.toMatch(/const showMap = ref\(/)
    const panel = page.match(/<MobileCanvasTopControls[\s\S]*?\/>/)?.[0] ?? ''
    expect(panel).toContain(':minimap-expanded="viewportSettings.minimapExpanded"')
    expect(panel).toContain('@toggle-minimap="cycleMinimap"')
  })

  it('自动保存状态行：存在且接 saving/savedAt；顶栏菜单不再有「保存画布」', () => {
    // PR5（D-9）：移动端编排迁入 MobileCanvasShell，CanvasPage 仅以 v-if="isMobileLayout" 委托
    expect(page, 'CanvasPage 必须委托移动端壳层').toContain('<MobileCanvasShell')
    const status = shell.match(/<MobileSaveStatus[\s\S]*?\/>/)?.[0] ?? ''
    expect(status, '壳层必须渲染 MobileSaveStatus').toContain(':saving="saving"')
    expect(status).toContain(':saved-at="savedAt"')
    // 多选态不出状态行（与动作条抢同一条底部清位）
    expect(status).toContain('!multiSelectActive')
    const topBarCode = stripComments(topBar)
    expect(topBarCode).not.toContain('保存画布')
    expect(topBarCode).not.toMatch(/action === 'save'/)
    // 有效性配对：菜单里确实还有其它项（防空集假绿）
    expect(topBarCode).toContain('发布作品')
    // 只扫壳层内 MobileTopBar 开标签本身——跨标签的非贪婪匹配会命中后面别的组件（PC
    // CanvasFloatingChrome 仍有 @save），那是另一个组件的合法接线。
    const topBarTag = stripComments(shell).match(/<MobileTopBar[\s\S]*?\/>/)?.[0] ?? ''
    expect(topBarTag, '必须能定位 MobileTopBar 开标签').toContain('MobileTopBar')
    expect(topBarTag).not.toContain('@save=')
  })

  it('保存时间只在真正落库成功后打点（不在 finally 的失败路径）', () => {
    const save = page.match(/async function saveCanvas\(\)[\s\S]*?\n}/)?.[0] ?? ''
    const putAt = save.indexOf('await api.put(')
    const stampAt = save.indexOf('lastSavedAt.value = Date.now()')
    expect(putAt, 'saveCanvas 里应有 api.put').toBeGreaterThan(0)
    expect(stampAt, '打点应存在').toBeGreaterThan(putAt)
    expect(save.slice(putAt, stampAt)).not.toContain('catch')
  })

  it('⋯ 菜单按频次重排 + 导出二级（完整包 / 轻量包）', () => {
    const menu = stripComments(topBar).match(/<div v-if="menuOpen"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? ''
    expect(menu).toContain('发布作品')
    expect(menu).toContain('导入工作流')
    // 分镜板已随 #494 分镜节点下线而退役（StoryboardDialog 删除）⇒ 不得留死入口
    expect(menu).not.toContain('分镜板')
    expect(stripComments(topBar)).not.toContain('storyboard')
    expect(menu).toContain('data-testid="bar-menu-export"')
    expect(menu).toContain('bar-menu-export-sub')
    expect(menu).toContain('轻量包（不含媒体）')
    // 顺序：发布 → 导出 → 导入
    expect(menu.indexOf('发布作品')).toBeLessThan(menu.indexOf('bar-menu-export"'))
    expect(menu.indexOf('bar-menu-export"')).toBeLessThan(menu.indexOf('导入工作流'))
    // 接线：轻量包走 onExportPack([], 'lightweight')（PR5 迁入 MobileCanvasShell）
    expect(shell).toContain(`@export-workflow-light="onExportPack([], 'lightweight')"`)
  })

  it('三个零引用死代码文件已删除', () => {
    for (const f of ['CanvasZoomBar.vue', 'GenerationBar.vue', 'CanvasStatus.vue']) {
      expect(existsSync(join(here, '..', 'components', 'canvas', f)), `${f} 应已删除`).toBe(false)
    }
  })

  it('AGENTS.md 写入 isMobileLayout 治理规则（编排单一所有者 / 禁新增媒体查询 / 形态×能力）', () => {
    const agents = readFileSync(join(here, '..', '..', '..', '..', 'AGENTS.md'), 'utf8')
    expect(agents).toContain('移动端呈现')
    expect(agents).toContain('不再新增')
    expect(agents).toContain('media query')
    expect(agents).toContain('形态')
    expect(agents).toContain('能力集')
  })
})

describe('MobileSaveStatus 行为', () => {
  it('保存中 → 文案「保存中…」且禁用；否则显示已保存时刻', () => {
    const saving = mount(MobileSaveStatus, { props: { saving: true, savedAt: null } })
    expect(saving.find('.mss-label').text()).toBe('保存中…')
    expect(saving.find('button').attributes('disabled')).toBeDefined()
    saving.unmount()

    const done = mount(MobileSaveStatus, { props: { saving: false, savedAt: new Date(2026, 0, 2, 15, 4).getTime() } })
    expect(done.find('.mss-label').text()).toBe('已保存 15:04')
    expect(done.find('button').attributes('disabled')).toBeUndefined()
    done.unmount()
  })

  it('点按 → emit save（能力不删，只是不再占菜单一位）', async () => {
    const w = mount(MobileSaveStatus, { props: { saving: false, savedAt: 1 } })
    await w.find('button').trigger('click')
    expect(w.emitted('save')).toHaveLength(1)
    w.unmount()
  })
})
