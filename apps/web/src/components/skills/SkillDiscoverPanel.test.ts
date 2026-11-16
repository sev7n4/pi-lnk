// 文件：apps/web/src/components/skills/SkillDiscoverPanel.test.ts
// M1-3 发现页双区组件守卫（RED 先行判据，计划 §4）：
//  ① 关闭态（enabled=false）不渲染「已启用」标记；启用态才渲染。
//  ② 卸载必须二次确认：点卸载只弹确认框，不触发 DELETE；缺确认（取消）不触发 DELETE。
//  ③ 市场区卡片点安装 → POST install；我的技能区拉 mine。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SkillDiscoverPanel from './SkillDiscoverPanel.vue'

const { catalog, mine, install, setEnabled, remove, rollback } = vi.hoisted(() => ({
  catalog: vi.fn(), mine: vi.fn(), install: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), rollback: vi.fn(),
}))
vi.mock('@/services/skill-api', () => ({
  skillApi: { catalog, mine, install, setEnabled, remove, rollback },
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
    setEnabled.mockReset(); remove.mockReset(); rollback.mockReset()
    catalog.mockResolvedValue(CATALOG)
    mine.mockResolvedValue(MINE)
    install.mockResolvedValue({ enabled: false })
    setEnabled.mockResolvedValue({ id: 'row-1', enabled: true })
    remove.mockResolvedValue({ uninstalled: 1 })
    rollback.mockResolvedValue({ id: 'row-2', pinnedHash: 'p0' })
  })

  it('挂载拉市场区 catalog 与我的技能区 mine', async () => {
    await mountPanel()
    expect(catalog).toHaveBeenCalled()
    expect(mine).toHaveBeenCalled()
  })

  it('① 关闭态不渲染「已启用」标记；启用态才渲染（关闭态不渲染启用卡片）', async () => {
    const wrapper = await mountPanel('mine')
    const rows = wrapper.findAll('[data-testid="mine-skill-row"]')
    expect(rows).toHaveLength(2)
    // row-1 enabled=false、row-2 enabled=true
    expect(rows[0]!.text()).not.toContain('已启用')
    expect(rows[1]!.text()).toContain('已启用')
  })

  it('② 卸载必须二次确认：点卸载只弹确认框，取消不触发 DELETE', async () => {
    const wrapper = await mountPanel('mine')
    await wrapper.findAll('[data-testid="mine-uninstall"]')[0]!.trigger('click')
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    // 取消 → 关闭弹窗，仍不触发 DELETE
    await wrapper.find('[data-testid="confirm-cancel"]').trigger('click')
    expect(remove).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
  })

  it('② 卸载二次确认：确认后才 DELETE，且带 confirmed', async () => {
    const wrapper = await mountPanel('mine')
    await wrapper.findAll('[data-testid="mine-uninstall"]')[0]!.trigger('click')
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

  it('启停开关 → setEnabled(id, enabled)', async () => {
    const wrapper = await mountPanel('mine')
    const toggle = wrapper.findAll('[data-testid="mine-toggle"]')[0]!
    await toggle.trigger('click')
    await flushPromises()
    expect(setEnabled).toHaveBeenCalledWith('row-1', true)
  })

  it('失败不崩：catalog 拒绝 → 市场区空态', async () => {
    catalog.mockRejectedValue(new Error('down'))
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="market-empty"]').exists()).toBe(true)
  })
})
