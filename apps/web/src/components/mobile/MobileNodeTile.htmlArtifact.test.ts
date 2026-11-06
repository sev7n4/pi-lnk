/**
 * 规格 #636 §4.7 / §4.2 在移动端磁贴的落地守卫（2026-11-06 补齐零覆盖）：
 * HTML 产物 = 徽章 + 摘要，⛔ 节点卡不跑 iframe、⛔ 绝不 v-html 注宿主 DOM、
 * ⛔ 禁止按内容嗅探自动切换（只认显式 data.format）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeTile from './MobileNodeTile.vue'

function tile(data: Record<string, unknown>) {
  return mount(MobileNodeTile, { props: { type: 'text', data } })
}

describe('MobileNodeTile — HTML 格式文本节点显示', () => {
  const html = '<!DOCTYPE html><html><head><title>秋季活动落地页</title></head><body><h1>你好</h1><script>alert(1)</script></body></html>'

  it('format:html ⇒ HTML 徽章 + <title> 摘要，不渲染 iframe', () => {
    const w = tile({ content: html, format: 'html' })
    expect(w.find('[data-testid="mobile-node-html-badge"]').text()).toBe('HTML')
    expect(w.find('[data-testid="mobile-node-html-summary"]').text()).toBe('秋季活动落地页')
    expect(w.find('iframe').exists()).toBe(false)
    expect(w.find('.mobile-node-text').exists()).toBe(false)
    w.unmount()
  })

  it('宿主 DOM 里 HTML 源码只作文本，不执行、不注入 script 节点', () => {
    const w = tile({ content: html, format: 'html' })
    expect(w.find('script').exists()).toBe(false)
    expect(w.find('h1').exists()).toBe(false)
    // 摘要是插值文本，不是 innerHTML
    expect(w.html()).not.toContain('<script>')
    w.unmount()
  })

  it('字数按剥标签后的可见文本统计（标签不计入）', () => {
    const w = tile({ content: '<div>你好世界</div>', format: 'html' })
    expect(w.find('[data-testid="mobile-node-text-info"]').text()).toBe('4 字')
    w.unmount()
  })

  it('digest 系统产物 ⇒ 徽章为「总览」，与 agent HTML 产物可区分', () => {
    const w = tile({ content: html, format: 'html', digest: true })
    expect(w.find('[data-testid="mobile-node-html-badge"]').text()).toBe('总览')
    w.unmount()
  })

  it('⛔ 不嗅探：content 长得像 HTML 但无 format ⇒ 仍走纯文本阅读路径', () => {
    const w = tile({ content: html })
    expect(w.find('[data-testid="mobile-node-html-badge"]').exists()).toBe(false)
    expect(w.find('.mobile-node-text').exists()).toBe(true)
    expect(w.find('iframe').exists()).toBe(false)
    w.unmount()
  })

  it('非法 format ⇒ fail-soft 降级 plain', () => {
    const w = tile({ content: html, format: 'jsx' })
    expect(w.find('[data-testid="mobile-node-html-badge"]').exists()).toBe(false)
    w.unmount()
  })

  it('纯文本节点既有显示零回归', () => {
    const w = tile({ content: '一段普通文案' })
    expect(w.find('.mobile-node-text').text()).toBe('一段普通文案')
    expect(w.find('[data-testid="mobile-node-text-info"]').text()).toBe('6 字')
    w.unmount()
  })
})
