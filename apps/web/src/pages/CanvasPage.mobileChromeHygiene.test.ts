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

// PR5（D-9）治理守卫：移动端编排单一所有者。
// AGENTS.md「移动端呈现」第 1 条要求「页面级组件不再新增 isMobileLayout 条件分支」，
// 但那条规则在 PR4 只是「约定」——没有任何机器判据。PR5 抽出壳层后它才第一次可判定：
// 移动端专属子组件（顶栏 / 页签 / 状态行 / 发现 / 我的 / 账号面板 / ＋FAB / 新建·任务 sheet /
// 多选动作条）在 CanvasPage 里必须**零**出现，编排只在 MobileCanvasShell 一处。
describe('PR5 移动端编排单一所有者（壳层）', () => {
  const page = stripComments(read('./CanvasPage.vue'))
  const shell = readComponent('mobile/MobileCanvasShell.vue')

  it('CanvasPage 不再直接渲染移动端子组件（编排已上收壳层）', () => {
    for (const comp of [
      'MobileTopBar',
      'MobileTabBar',
      'MobileSaveStatus',
      'DiscoverPane',
      'ProfilePane',
      'MobileMultiSelectBar',
      'MobileCanvasCreateFab',
      'MobileCreateSheet',
      'MobileTaskSheet',
    ]) {
      expect(page, `CanvasPage 不该再直接渲染 <${comp}>`).not.toContain(`<${comp}`)
    }
    // 有效性配对：壳层确实渲染了这些组件（防空集假绿）
    for (const comp of [
      'MobileTopBar',
      'MobileTabBar',
      'MobileSaveStatus',
      'DiscoverPane',
      'ProfilePane',
      'MobileMultiSelectBar',
      'MobileCanvasCreateFab',
      'MobileCreateSheet',
      'MobileTaskSheet',
    ]) {
      expect(shell, `壳层必须渲染 <${comp}>`).toContain(`<${comp}`)
    }
  })

  it('壳层自身不再判断断点（由 CanvasPage 的 v-if 包裹，内部零 isMobileLayout）', () => {
    // 壳层只在移动端渲染 ⇒ 内部再判 isMobileLayout 就是「断点判断没有单一所有者」
    expect(stripComments(shell)).not.toContain('isMobileLayout')
    expect(stripComments(shell)).not.toContain('useAgentMobileLayout')
    // 且 CanvasPage 必须以 isMobileLayout 包裹它
    expect(page).toMatch(/<MobileCanvasShell\s+v-if="isMobileLayout"/)
  })

  it('壳层零 --neo-*（旧体系棘轮只增不减）', () => {
    expect(shell).not.toContain('--neo-')
  })
})

/**
 * 真机走查 2026-10-20 抓到的缺陷类（jsdom 无视口 ⇒ CI 全绿也看不见）：
 * 移动端底部锚定元素若用 `position: absolute` 贴 **100vh 根容器底边**，
 * 而页签栏 / 顶栏是 `fixed` 贴**可见视口** —— 移动浏览器带地址栏 + 底部工具条时
 * 100vh 比可见视口高约 105px（真机实测 804 / 699）⇒ 锚底的 absolute 元素
 * 整颗掉出可见区（＋FAB 不可见 ⇒ 空态文案「点左下 ＋」成死指引；保存状态行、
 * 多选动作条同理）。
 */
describe('移动端底部锚定元素：fixed 贴可见视口（真机走查 2026-10-20）', () => {
  const fab = readComponent('mobile/MobileCanvasCreateFab.vue')
  const status = readComponent('mobile/MobileSaveStatus.vue')
  const bar = readComponent('mobile/MobileMultiSelectBar.vue')
  const shell = readComponent('mobile/MobileCanvasShell.vue')

  /** 取某选择器的首个样式块（先剥注释，避免注释里的词命中断言） */
  function cssBlock(sfc: string, selector: string): string {
    const clean = stripComments(sfc)
    const idx = clean.indexOf(`${selector} {`)
    if (idx < 0) return ''
    return clean.slice(idx, clean.indexOf('}', idx) + 1)
  }

  it('＋FAB / 保存状态行 / 多选动作条必须是 fixed，不得回退 absolute', () => {
    for (const [name, sfc, sel] of [
      ['＋FAB', fab, '.mobile-create-fab'],
      ['保存状态行', status, '.mobile-save-status'],
      ['多选动作条', bar, '.mobile-multi-select-bar'],
    ] as const) {
      const block = cssBlock(sfc, sel)
      expect(block, `${name} 必须有样式块`).not.toBe('')
      // 有效性配对：它确实是底部锚定元素（走清位公式）
      expect(block, `${name} 须是底部锚定（bottom 走清位公式）`).toContain(
        'bottom: calc(var(--lnk-agent-dock-h',
      )
      expect(block, `${name} 必须 fixed 贴可见视口`).toContain('position: fixed')
      expect(block, `${name} 不得回退 absolute（会掉出可见区）`).not.toContain(
        'position: absolute',
      )
    }
  })

  it('＋FAB 与保存状态行不得同位（曾同 left + 同 bottom ⇒ FAB 压住状态行圆点与首字）', () => {
    const leftOf = (block: string) => block.match(/left:\s*([\d.]+px)/)?.[1]
    const fabLeft = leftOf(cssBlock(fab, '.mobile-create-fab'))
    const statusLeft = leftOf(cssBlock(status, '.mobile-save-status'))
    expect(fabLeft, 'FAB 贴左边 12px').toBe('12px')
    expect(statusLeft, '状态行须横向让开 FAB（12 + 48 + 8）').toBe('68px')
    expect(statusLeft, '二者 left 必须不同').not.toBe(fabLeft)
  })

  it('多选态不出 ＋FAB（多选动作条接管同一条底部清位）', () => {
    const fabTag = shell.match(/<MobileCanvasCreateFab[\s\S]*?\/>/)?.[0] ?? ''
    expect(fabTag, '必须能定位 FAB 开标签').toContain('<MobileCanvasCreateFab')
    expect(fabTag, '多选态须让位给动作条').toContain('!multiSelectActive')
    // 有效性配对：保存状态行同一规则（两条底部元素不同时出现）
    const statusTag = shell.match(/<MobileSaveStatus[\s\S]*?\/>/)?.[0] ?? ''
    expect(statusTag, '必须能定位状态行开标签').toContain('<MobileSaveStatus')
    expect(statusTag, '状态行同一让位规则').toContain('!multiSelectActive')
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
