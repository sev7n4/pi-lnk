// 文件：apps/web/src/components/skills/SkillDiscoverPanel.test.ts
// M1-3 发现页双区组件守卫（RED 先行判据，计划 §4）：
//  ① 关闭态（enabled=false）不渲染「已启用」标记；启用态才渲染。
//  ② 卸载必须二次确认：点卸载只弹确认框，不触发 DELETE；缺确认（取消）不触发 DELETE。
//  ③ 市场区卡片点安装 → POST install；我的技能区拉 mine。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import SkillDiscoverPanel from './SkillDiscoverPanel.vue'

const { catalog, mine, install, setEnabled, remove, rollback, uninstallBatch } = vi.hoisted(() => ({
  catalog: vi.fn(), mine: vi.fn(), install: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), rollback: vi.fn(), uninstallBatch: vi.fn(),
}))
vi.mock('@/services/skill-api', () => ({
  skillApi: { catalog, mine, install, setEnabled, remove, rollback, uninstallBatch },
}))

const CATALOG = [
  { packageHash: 'p1', skill: 'task-decomposition', displayName: '任务分解', summary: '拆任务', version: '1.0', vertical: '通用', tags: [], featured: false, usageCount: 0, installCount: 0, compatProfile: 'C0', compatScore: 1, license: 'MIT', publisher: 'platform', description: 'd' },
  { packageHash: 'p2', skill: 'storyboard', displayName: '分镜', summary: '镜头表', version: '1.0', vertical: '短剧', tags: [], featured: true, usageCount: 5, installCount: 2, compatProfile: 'C1', compatScore: 0.8, license: 'MIT', publisher: 'platform', description: 'd' },
]
const MINE = [
  { id: 'row-1', packageHash: 'p1', sourceType: 'catalog', trustLevel: 'reviewed', enabled: false, pinnedHash: 'p1', installedAt: '2026-11-16T00:00:00Z', skill: 'task-decomposition', displayName: '任务分解', publisher: 'platform', version: '1.0', compatProfile: 'C0', disableModelInvocation: false, userInvocable: true },
  { id: 'row-2', packageHash: 'p2', sourceType: 'paste', trustLevel: 'unreviewed', enabled: true, pinnedHash: 'p2', installedAt: '2026-11-15T00:00:00Z', skill: 'storyboard', displayName: '分镜', publisher: 'user-1', version: '1.0', compatProfile: 'C1', disableModelInvocation: false, userInvocable: true },
]

async function mountPanel(startTab: 'market' | 'mine' = 'market') {
  const wrapper = mount(SkillDiscoverPanel, { props: { initialTab: startTab } })
  await flushPromises()
  return wrapper
}

describe('SkillDiscoverPanel — M1-3 发现页双区', () => {
  beforeEach(() => {
    catalog.mockReset(); mine.mockReset(); install.mockReset()
    setEnabled.mockReset(); remove.mockReset(); rollback.mockReset(); uninstallBatch.mockReset()
    catalog.mockResolvedValue(CATALOG.map((c) => ({ ...c })))
    // onToggle 会就地改 item.enabled；每次给新对象，避免测试间状态串味（U6 曾因此假红）
    mine.mockResolvedValue(MINE.map((m) => ({ ...m })))
    install.mockResolvedValue({ enabled: false })
    setEnabled.mockResolvedValue({ id: 'row-1', enabled: true })
    remove.mockResolvedValue({ uninstalled: 1 })
    rollback.mockResolvedValue({ id: 'row-2', pinnedHash: 'p0' })
    uninstallBatch.mockResolvedValue({ uninstalled: 2 })
  })

  it('挂载拉市场区 catalog 与我的技能区 mine', async () => {
    await mountPanel()
    expect(catalog).toHaveBeenCalled()
    expect(mine).toHaveBeenCalled()
  })

  it('① P3 卡片开关语义：启用态 aria-checked=true，停用态 false（两卡片总数不变）', async () => {
    const wrapper = await mountPanel('mine')
    const rows = wrapper.findAll('[data-testid="mine-skill-row"]')
    expect(rows).toHaveLength(2)
    // P3 分组：用户自定义组在前（row-2 paste 启用），来自市场在后（row-1 catalog 停用）
    const toggles = wrapper.findAll('[data-testid="mine-toggle"]')
    expect(toggles).toHaveLength(2)
    expect(toggles[0]!.attributes('aria-checked')).toBe('true')
    expect(toggles[1]!.attributes('aria-checked')).toBe('false')
  })

  it('② 卸载必须二次确认：点卸载只弹确认框，取消不触发 DELETE', async () => {
    const wrapper = await mountPanel('mine')
    // row-1 在「来自市场」组（分组后 DOM 序：自定义 row-2 → 市场 row-1）
    await wrapper.findAll('[data-testid="mine-uninstall"]')[1]!.trigger('click')
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    // 取消 → 关闭弹窗，仍不触发 DELETE
    await wrapper.find('[data-testid="confirm-cancel"]').trigger('click')
    expect(remove).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
  })

  it('② 卸载二次确认：确认后才 DELETE，且带 confirmed', async () => {
    const wrapper = await mountPanel('mine')
    await wrapper.findAll('[data-testid="mine-uninstall"]')[1]!.trigger('click')
    await wrapper.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith('row-1')
    // 卸载后重新拉 mine
    expect(mine).toHaveBeenCalledTimes(2)
  })

  it('③ 市场卡片点安装 → install(packageHash)', async () => {
    const wrapper = await mountPanel()
    await wrapper.findAll('[data-testid="market-install"]')[0]!.trigger('click')
    await flushPromises()
    expect(install).toHaveBeenCalledWith('p1')
  })

  it('启停开关 → setEnabled(id, enabled)（P3 开关 = aria-checked 切换）', async () => {
    const wrapper = await mountPanel('mine')
    // [0] = 自定义组 row-2（enabled=true → 停用 false）
    const toggle = wrapper.findAll('[data-testid="mine-toggle"]')[0]!
    await toggle.trigger('click')
    await flushPromises()
    expect(setEnabled).toHaveBeenCalledWith('row-2', false)
  })

  it('P3 分组：paste 进「用户自定义」组，catalog 进「来自市场」组', async () => {
    const wrapper = await mountPanel('mine')
    const custom = wrapper.find('[data-testid="group-custom"]')
    const market = wrapper.find('[data-testid="group-market"]')
    expect(custom.exists()).toBe(true)
    expect(market.exists()).toBe(true)
    expect(custom.text()).toContain('分镜')
    expect(market.text()).toContain('任务分解')
  })

  it('P3 搜索：按 displayName 过滤两分组', async () => {
    const wrapper = await mountPanel('mine')
    const search = wrapper.find('[data-testid="mine-search"]')
    await search.setValue('任务')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="mine-skill-row"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('任务分解')
  })

  it('P3 批量卸载：勾选两卡 → 确认弹窗 → uninstallBatch(ids, true) + 退出批量', async () => {
    const wrapper = await mountPanel('mine')
    await wrapper.find('[data-testid="toggle-batch"]').trigger('click')
    const rows = wrapper.findAll('[data-testid="mine-skill-row"]')
    await rows[0]!.trigger('click')
    await rows[1]!.trigger('click')
    await wrapper.find('[data-testid="batch-uninstall"]').trigger('click')
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(true)
    expect(uninstallBatch).not.toHaveBeenCalled()
    await wrapper.find('[data-testid="confirm-ok"]').trigger('click')
    await flushPromises()
    expect(uninstallBatch).toHaveBeenCalledWith(['row-2', 'row-1'], true)
  })

  it('P3 导入：open-import 弹 SkillImportDialog，导入成功刷新 mine（N5 靶点）', async () => {
    const wrapper = await mountPanel('mine')
    expect(wrapper.find('[data-testid="import-dialog"]').exists()).toBe(false)
    await wrapper.find('[data-testid="open-import"]').trigger('click')
    expect(wrapper.find('[data-testid="import-dialog"]').exists()).toBe(true)
    // 模拟子组件导入成功 → mine 重拉 + 通知宿主
    const dialog = wrapper.findComponent({ name: 'SkillImportDialog' })
    expect(dialog.exists()).toBe(true)
    dialog.vm.$emit('imported', 'new-skill')
    await flushPromises()
    expect(mine).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('skills-changed')).toBeTruthy()
  })

  it('失败不崩：catalog 拒绝 → 市场区空态', async () => {
    catalog.mockRejectedValue(new Error('down'))
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="market-empty"]').exists()).toBe(true)
  })

  // ── F2（2026-11-17 P3 真机修复）：内置技能只读分区 ──
  const BUILTIN = [
    { id: 'code-review', label: '代码评审', desc: '平台内置' },
    { id: 'brainstorm', label: '头脑风暴', desc: '平台内置' },
    { id: 'writing', label: '文案写作', desc: '平台内置' },
  ]

  it('F2/N3：传 builtinSkills 时「我的技能」顶部渲染只读内置分区，条目数匹配、无开关/卸载', async () => {
    const wrapper = mount(SkillDiscoverPanel, { props: { initialTab: 'mine', builtinSkills: BUILTIN } })
    await flushPromises()
    const section = wrapper.find('[data-testid="builtin-section"]')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('内置技能（3）')
    expect(wrapper.findAll('[data-testid="builtin-skill-row"]')).toHaveLength(3)
    // 内置分区内不含任何开关/卸载出口（N3 靶：内置不可停用/卸载）
    expect(section.find('[data-testid="mine-toggle"]').exists()).toBe(false)
    expect(section.find('[data-testid="mine-uninstall"]').exists()).toBe(false)
    expect(section.find('[data-testid="mine-rollback"]').exists()).toBe(false)
    // 用户已安装区开关仍独立存在（边界不混）
    expect(wrapper.findAll('[data-testid="mine-toggle"]')).toHaveLength(2)
  })

  it('F2/N2：内置分区数据纯 prop 消费——不传不渲染，面板不额外拉 runtime', async () => {
    const wrapper = await mountPanel('mine')
    expect(wrapper.find('[data-testid="builtin-section"]').exists()).toBe(false)
    // skillApi mock 没有 runtimeList：若面板内拉 runtime 会抛错/被调用；此处确认只拉 catalog+mine
    expect(catalog).toHaveBeenCalled()
    expect(mine).toHaveBeenCalled()
  })

  it('F2：内置分区同样响应搜索过滤', async () => {
    const wrapper = mount(SkillDiscoverPanel, { props: { initialTab: 'mine', builtinSkills: BUILTIN } })
    await flushPromises()
    await wrapper.find('[data-testid="mine-search"]').setValue('头脑')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="builtin-skill-row"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('头脑风暴')
  })

  // ── UI 美化 §4.4 / §4.5 / §4.3（U6 / U7 / U3）──
  it('U6：开关文案讲清「停用后果」而非「自动触发」；副标题区分启用态', async () => {
    const wrapper = await mountPanel('mine')
    const [onToggleBtn, offToggleBtn] = wrapper.findAll('[data-testid="mine-toggle"]')
    expect(onToggleBtn!.attributes('aria-label')).toContain('停用后不再自动生效，也不出现在 + / / 列表')
    expect(onToggleBtn!.attributes('aria-label')).not.toContain('自动触发')
    expect(offToggleBtn!.attributes('aria-checked')).toBe('false')
    expect(wrapper.text()).toContain('已启用 · 自动可用')
    expect(wrapper.text()).toContain('已停用')
    expect(onToggleBtn!.attributes('role')).toBe('switch')
  })

  it('U7：内置 / 自定义 / 来自市场三类卡片均可打开同一只读详情壳', async () => {
    const wrapper = mount(SkillDiscoverPanel, { props: { initialTab: 'mine', builtinSkills: BUILTIN } })
    await flushPromises()
    // MobileSheet Teleport 到 body，wrapper.find 穿不过去——从 document.body 取证
    // kind 标签在 MobileSheet 的 subtitle（Teleport 根），不在 detail-sheet 内，故取整个 body
    const detailText = () => document.body.textContent ?? ''
    const closeDetail = async () => {
      ;(document.body.querySelector('[data-testid="m-sheet-close"]') as HTMLElement | null)?.click()
      await flushPromises()
      // MobileSheet 的离场 transition 会短暂保留 Teleport 节点；等真实计时器走完再断言
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const opens = wrapper.findAll('[data-testid="skill-detail-open"]')
    expect(opens).toHaveLength(5) // 3 内置 + 2 已安装
    await opens[0]!.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="skill-detail-sheet"]')).not.toBeNull()
    expect(detailText()).toContain('代码评审')
    expect(detailText()).toContain('平台提供 · 常开 · 不可停用')
    await closeDetail()
    expect(detailText()).toBe('')

    await opens[3]!.trigger('click') // 0-2 内置，3 自定义，4 来自市场
    await flushPromises()
    expect(detailText()).toContain('用户自定义')
    expect(detailText()).toContain('已启用 · 自动可用')
    await closeDetail()

    await opens[4]!.trigger('click')
    await flushPromises()
    expect(detailText()).toContain('来自市场')
    await closeDetail()
    wrapper.unmount()
  })

  it('U7：批量态点卡片仍=勾选，不弹详情', async () => {
    // 清掉上一例 transition 残留（Teleport 到 body，不受 wrapper.unmount 管辖）
    document.body.querySelectorAll('.m-sheet-root').forEach((el) => el.remove())
    const wrapper = await mountPanel('mine')
    await wrapper.find('[data-testid="toggle-batch"]').trigger('click')
    await wrapper.findAll('[data-testid="mine-skill-row"]')[0]!.trigger('click')
    expect(document.body.querySelector('[data-testid="skill-detail-sheet"]')).toBeNull()
    expect(wrapper.text()).toContain('已选 1 个')
    wrapper.unmount()
  })

  it('U3：工具栏两行稳定、批量计数独占第二行；移动端卡片单列；空态文案指向内置技能', () => {
    const sfc = readFileSync(join(__dirname, 'SkillDiscoverPanel.vue'), 'utf8')
    expect(sfc).toContain('class="mine-toolbar-row"')
    expect(sfc).toMatch(/@media \(max-width: 639px\) \{ \.cards-grid \{ grid-template-columns: 1fr; \} \}/)
    expect(sfc).toContain('data-testid="batch-bar"')
    // T3.1：mine 空态不再用「还没有已安装技能」，改为说明内置技能由平台提供 + 下一步
    expect(sfc).toContain('内置技能由平台提供，导入或安装后可在此管理')
    expect(sfc).not.toContain('还没有已安装技能')
  })

  it('U4：开关 51×31 / knob 27 / 触控热区 ≥44，内置卡无开关（见 F2）', () => {
    const sfc = readFileSync(join(__dirname, 'SkillDiscoverPanel.vue'), 'utf8')
    expect(sfc).toMatch(/\.mine-switch \{[^}]*width: 51px; height: 31px;/)
    expect(sfc).toContain('.mine-switch::after { content: \'\'; position: absolute; inset: -7px; }')
    expect(sfc).toContain('width: 27px; height: 27px;')
  })
})
