// P3 SkillPickSheet 组件测试：sheet 选择 / toggle 胶囊 / 清空 / 管理入口（判据 C1/C2/C6）。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SkillPickSheet from './SkillPickSheet.vue'

const SKILLS = [
  { id: 'ecommerce-product-photo', label: '实物产品视觉出图', desc: '白底图' },
  { id: 'html-craft', label: 'HTML 页面工艺', desc: '页面' },
]

function mountSheet(selectedIds: string[] = []) {
  return mount(SkillPickSheet, {
    props: { skills: SKILLS, selectedIds },
  })
}

describe('SkillPickSheet（P3 技能选择 sheet）', () => {
  it('渲染数据源全部技能 + 自动项；skills 为空只留自动项', () => {
    const w = mountSheet()
    expect(w.findAll('[data-testid="pick-skill"]')).toHaveLength(2)
    expect(w.find('[data-testid="pick-auto"]').exists()).toBe(true)
    const empty = mount(SkillPickSheet, { props: { skills: [], selectedIds: [] } })
    expect(empty.findAll('[data-testid="pick-skill"]')).toHaveLength(0)
    expect(empty.find('[data-testid="pick-auto"]').exists()).toBe(true)
  })

  it('点选技能 → emit toggle(id)；已选中项有 ✓ 标记', async () => {
    const w = mountSheet(['ecommerce-product-photo'])
    const checked = w.findAll('[data-testid="pick-checked"]')
    expect(checked).toHaveLength(1)
    await w.findAll('[data-testid="pick-skill"]')[1]!.trigger('click')
    expect(w.emitted('toggle')).toEqual([['html-craft']])
  })

  it('点自动 → emit clear；关闭按钮 → emit close', async () => {
    const w = mountSheet()
    await w.find('[data-testid="pick-auto"]').trigger('click')
    expect(w.emitted('clear')).toBeTruthy()
    await w.find('[data-testid="sheet-close"]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })

  it('底部【管理技能】入口 → emit manage（C6）', async () => {
    const w = mountSheet()
    await w.find('[data-testid="manage-skills-btn"]').trigger('click')
    expect(w.emitted('manage')).toBeTruthy()
  })
})
