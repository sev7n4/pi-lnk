// P3 SkillPickSheet 组件测试：sheet 选择 / toggle 胶囊 / 清空 / 管理入口（判据 C1/C2/C6）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('点自动 → emit clear（关闭由宿主 MobileSheet / PC head 提供）', async () => {
    const w = mountSheet()
    await w.find('[data-testid="pick-auto"]').trigger('click')
    expect(w.emitted('clear')).toBeTruthy()
    expect(w.find('[data-testid="sheet-close"]').exists()).toBe(false)
  })

  it('底部【管理技能】入口 → emit manage（C6）', async () => {
    const w = mountSheet()
    await w.find('[data-testid="manage-skills-btn"]').trigger('click')
    expect(w.emitted('manage')).toBeTruthy()
  })

  it('U2：纯内容 sheet——品牌头像分类色标 / 圆形勾选 / 管理入口主操作', async () => {
    const w = mountSheet(['ecommerce-product-photo'])
    expect(w.findAll('[data-testid="brand-pattern"]')).toHaveLength(2)
    expect(w.find('[data-testid="pick-checked"]').classes()).toContain('pick-check')
    expect(w.find('[data-testid="manage-skills-btn"]').classes()).toContain('manage-btn')
    // 宿主提供标题/关闭，组件内不再自带 head
    expect(w.find('.sheet-head').exists()).toBe(false)
    const sfc = readFileSync(join(__dirname, 'SkillPickSheet.vue'), 'utf8')
    expect(sfc).toMatch(/\.pick-check \{[^}]*border-radius: var\(--lnk-radius-full\)/)
    expect(sfc).toContain('background: var(--lnk-accent)')
    expect(sfc).toContain('border: 1px solid var(--lnk-accent-border)')
    w.unmount()
  })

  it('滚动区允许收缩（flex min-height:0），防内容溢出把管理入口顶出视口（#950 生产复测）', () => {
    const sfc = readFileSync(join(__dirname, 'SkillPickSheet.vue'), 'utf8')
    expect(sfc).toMatch(/\.sheet-body \{ flex: 1; min-height: 0; overflow-y: auto;/)
    expect(sfc).toMatch(/\.skill-pick-sheet \{[^}]*min-height: 0;/)
  })

  it('R2（二轮 2026-11-18）：embedded 变体必须降级内层滚动（单一滚动容器，灭触摸死区）', () => {
    const sfc = readFileSync(join(__dirname, 'SkillPickSheet.vue'), 'utf8')
    expect(sfc).toMatch(/\.skill-pick-sheet\.embedded \.sheet-body \{ overflow-y: visible; overscroll-behavior: auto; \}/)
    // prop 契约：根元素按 embedded 挂变体类
    expect(sfc).toContain(':class="{ embedded: props.embedded }"')
  })
})
