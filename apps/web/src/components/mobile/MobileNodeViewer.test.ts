import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeViewer from './MobileNodeViewer.vue'

describe('MobileNodeViewer', () => {
  it('image: 全屏灯箱 + 返回薄条', () => {
    const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
    expect(w.find('.viewer-back').exists()).toBe(true)
    expect(w.find('img').exists()).toBe(true)
  })

  it('text: 渲染阅读器内容', () => {
    const w = mount(MobileNodeViewer, { props: { type: 'text', data: { content: '正文' } } })
    expect(w.text()).toContain('正文')
  })

  it('emit close on 返回', async () => {
    const w = mount(MobileNodeViewer, { props: { type: 'image', data: {} } })
    await w.find('.viewer-back').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
