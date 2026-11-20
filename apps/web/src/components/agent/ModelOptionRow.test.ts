import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ModelOptionRow from './ModelOptionRow.vue'
import type { SelectorModelOption } from '@/composables/useModelSelectorOptions'

/** 2026-11-21 模型卡 R2：PC popover 与移动 Sheet 共用列表行（WorkBuddy 排布：
 * 名称 + 可识图徽标 + 渠道徽标 + 行末倍率 + 选中勾）。本测试同时锁令牌合规。 */
function makeOption(overrides: Partial<SelectorModelOption> = {}): SelectorModelOption {
  return {
    id: 'platform::step-3.5-flash',
    name: 'step-3.5-flash',
    channelName: '平台',
    visionCapable: false,
    ...overrides,
  }
}

describe('ModelOptionRow', () => {
  it('渲染名称 + 可识图徽标 + 渠道徽标 + 行末倍率（两位小数 x）', () => {
    const w = mount(ModelOptionRow, {
      props: { option: makeOption({ visionCapable: true, multiplier: 1.1 }), selected: false },
    })
    expect(w.text()).toContain('step-3.5-flash')
    expect(w.text()).toContain('可识图')
    expect(w.text()).toContain('平台')
    expect(w.find('[data-testid="model-multiplier"]').text()).toBe('1.10x')
  })

  it('无倍率 → 不渲染倍率节点（禁造数）', () => {
    const w = mount(ModelOptionRow, { props: { option: makeOption(), selected: false } })
    expect(w.find('[data-testid="model-multiplier"]').exists()).toBe(false)
  })

  it('选中态：勾 + is-selected；点击 emit select', async () => {
    const w = mount(ModelOptionRow, { props: { option: makeOption(), selected: true } })
    expect(w.classes()).toContain('is-selected')
    expect(w.find('[data-testid="model-option-check"]').exists()).toBe(true)
    await w.trigger('click')
    expect(w.emitted('select')).toHaveLength(1)
  })

  it('不可用：disabled + 暂不可用 + 无勾；点击不 emit', async () => {
    const w = mount(ModelOptionRow, {
      props: { option: makeOption({ unavailable: true }), selected: true },
    })
    expect(w.attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('暂不可用')
    expect(w.find('[data-testid="model-option-check"]').exists()).toBe(false)
    await w.trigger('click')
    expect(w.emitted('select')).toBeUndefined()
  })

  it('健康角标：有 healthDot 渲染圆点，颜色随 red/warn', () => {
    const w = mount(ModelOptionRow, {
      props: { option: makeOption({ healthDot: { kind: 'red', title: '近24h成功率 30%' } }), selected: false },
    })
    expect(w.find('.mor-dot').exists()).toBe(true)
    expect(w.find('.mor-dot').classes()).toContain('is-red')
  })

  it('令牌合规（源码断言）：--lnk- 令牌、无 --neo-hi / --lnk-hi 翻转令牌', async () => {
    const { default: src } = await import('./ModelOptionRow.vue?raw')
    expect(src).not.toContain('--neo-hi')
    expect(src).not.toContain('--lnk-hi')
    expect(src).toContain('--lnk-accent-subtle')
    expect(src).toContain('--lnk-accent-text')
  })
})
