import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppEmptyState from './AppEmptyState.vue'

describe('AppEmptyState', () => {
  it('渲染主文案/次文案与 CTA slot，role=status', () => {
    const wrapper = mount(AppEmptyState, {
      slots: {
        default: '还没有画布',
        desc: '创建第一张画布，开始创作',
        action: '<button>新建画布</button>',
      },
    })
    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.text()).toContain('还没有画布')
    expect(wrapper.text()).toContain('创建第一张画布，开始创作')
    expect(wrapper.find('button').text()).toBe('新建画布')
  })

  it('缺省不渲染插画与空容器（本期不传 illustration）', () => {
    const wrapper = mount(AppEmptyState, { slots: { default: '空' } })
    expect(wrapper.find('img').exists()).toBe(false)
    // 无 desc/action 时不留空白节点
    expect(wrapper.findAll('p')).toHaveLength(1)
  })

  it('传 illustration 时渲染装饰性图片（空 alt + aria-hidden）', () => {
    const wrapper = mount(AppEmptyState, {
      props: { illustration: 'https://cdn/ink-fish.png' },
      slots: { default: '空' },
    })
    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('https://cdn/ink-fish.png')
    expect(img.attributes('alt')).toBe('')
    expect(img.attributes('aria-hidden')).toBe('true')
  })

  it('主/次文案层级符合 Design_system §3.9（主 14 强、次 12 弱）', () => {
    const wrapper = mount(AppEmptyState, {
      slots: { default: '主', desc: '次' },
    })
    const main = wrapper.find('p')
    const desc = wrapper.findAll('p')[1]
    expect(main.classes()).toContain('text-fg')
    expect(desc.classes()).toContain('text-fg-3')
  })
})
