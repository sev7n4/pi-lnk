import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import BrandPatternAvatar from './BrandPatternAvatar.vue'

describe('BrandPatternAvatar', () => {
  it('有真实头像时渲染 <img>（纹样让位）', () => {
    const wrapper = mount(BrandPatternAvatar, {
      props: { seed: 'u_1', name: '墨行者', src: 'https://cdn/a.png' },
    })
    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('https://cdn/a.png')
    expect(wrapper.text()).not.toContain('墨')
  })

  it('无真实头像时渲染纹样 + 首字母，且不出现 <img>', () => {
    const wrapper = mount(BrandPatternAvatar, {
      props: { seed: 'u_1', name: '墨行者', src: null },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[data-testid="brand-pattern"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('墨')
  })

  it('纹样走 --lnk-dim-rgb 恒黑通道（主题不变式，不随主题漂移）', () => {
    const wrapper = mount(BrandPatternAvatar, { props: { seed: 'u_1', name: '墨行者' } })
    const style = wrapper.find('[data-testid="brand-pattern"]').attributes('style') ?? ''
    expect(style).toContain('--lnk-dim-rgb')
    expect(style).toContain('radial-gradient')
  })

  it('size 三档各自映射不同尺寸类', () => {
    const cls = (size: 'sm' | 'md' | 'lg') =>
      mount(BrandPatternAvatar, { props: { seed: 'u_1', size } }).classes().join(' ')
    const sm = cls('sm')
    const md = cls('md')
    const lg = cls('lg')
    expect(sm).toContain('h-8')
    expect(md).toContain('h-12')
    expect(lg).toContain('h-16')
    expect(new Set([sm, md, lg]).size).toBe(3)
  })

  it('无 name 时首字母退化为空串，不抛错', () => {
    expect(() => mount(BrandPatternAvatar, { props: { seed: 'u_1' } })).not.toThrow()
  })
})
