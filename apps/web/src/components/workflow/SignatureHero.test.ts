import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SignatureHero from './SignatureHero.vue'
import CreativeLauncher from './CreativeLauncher.vue'

// ⚠️ jsdom 环境下 `fileURLToPath()` 必须收字符串：全局 URL 是 jsdom 的实现，
// 把 URL **对象**传给 Node 的 fileURLToPath 会报 "The URL must be of scheme file"。
const HERE = dirname(fileURLToPath(import.meta.url))

function mountHero() {
  return mount(SignatureHero, {
    props: { modelValue: '', greeting: '下午好' },
  })
}

describe('SignatureHero', () => {
  it('Enter 与主按钮触发同一个 create 动作（单 CTA）', async () => {
    const wrapper = mountHero()
    await wrapper.find('input').trigger('keydown.enter')
    await wrapper.findAll('button')[0]!.trigger('click')
    expect(wrapper.emitted('create')).toHaveLength(2)
  })

  it('不存在第二个同动作入口（guide 按钮已移除）', () => {
    const wrapper = mountHero()
    const texts = wrapper.findAll('button').map((b) => b.text())
    expect(texts.filter((t) => t.includes('告诉我你的想法'))).toHaveLength(0)
    expect(wrapper.findAll('button')).toHaveLength(1)
  })

  it('签名画面消费深海墨底令牌，不用浅色主题文字令牌', () => {
    const wrapper = mountHero()
    const html = wrapper.html()
    expect(html).toContain('var(--lnk-surface-signature)')
    expect(html).toContain('var(--lnk-text-on-signature)')
    expect(html).not.toContain('--lnk-text-muted')
    // 关键：深底上的次要文字若误用 text-fg-3（浅色主题为深色）会静默不可见
    expect(html).not.toContain('text-fg-3')
  })

  it('输入框在深底上走 signature 变体（placeholder 不用 text-fg-3）', () => {
    const wrapper = mountHero()
    const launcher = wrapper.findComponent(CreativeLauncher)
    expect(launcher.props('tone')).toBe('signature')
    expect(launcher.html()).not.toContain('text-fg-3')
  })

  it('粒子动效被 prefers-reduced-motion 降级', () => {
    // 注意：SFC 的 <style scoped> 不进入 wrapper.html()，必须读源码断言
    // 用 HERE（基于 import.meta.url 已在文件顶部验证可用的写法）拼接，避免 jsdom 的全局 URL 干扰
    const src = readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8')
    expect(src).toContain('@media (prefers-reduced-motion: reduce)')
    // 两个动效载体都必须被覆盖到，只停粒子不停 mascot 仍算漏
    const mediaBlock = src.slice(src.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(mediaBlock).toContain('.lnk-ink-particles')
    expect(mediaBlock).toContain('.lnk-mascot')
    expect(mediaBlock).toContain('animation: none')
  })

  it('问候语是左上角小字，h1 只属于主标题（每页唯一 h1）', () => {
    const wrapper = mountHero()
    // 问候语本身不是标题元素（P3-B 起主标题「想象，落定成图」升级为 h1，
    // 本断言从「全页无 h1」的旧结构假设改为「问候语不得占据标题位」）
    const greeting = wrapper.find('[data-greeting]')
    expect(greeting.element.tagName).toBe('P')
    expect(greeting.text()).toBe('下午好')
    expect(greeting.classes().join(' ')).toContain('text-sm')
    const h1 = wrapper.find('h1')
    expect(h1.exists()).toBe(true)
    expect(h1.text()).toContain('想象，落定成图')
    expect(wrapper.findAll('h1')).toHaveLength(1)
  })

  it('品牌 slogan 双行来自 constants/brand 单一真相源', () => {
    const wrapper = mountHero()
    const text = wrapper.text()
    expect(text).toContain('你体内早就有一囊墨，只是…没有找到你的锚。')
    expect(text).toContain('墨鱼π，锚定你的创意，一点一滴洒在画布，让画布记住你的模样。')
    // 小字禁走品牌渐变（F-5：渐变末端白字 3.67:1 不过 AA）——只许 on-signature 实色
    const html = wrapper.html()
    expect(html).toContain('var(--lnk-text-on-signature-muted)')
    expect(html).toContain('var(--lnk-text-on-signature)')
    expect(html).not.toContain('bg-brand-gradient')
    expect(html).not.toContain('bg-clip-text')
  })

  it('显色时刻渲染墨鱼π 品牌形象（与导航同源资产，不是按钮）', () => {
    const wrapper = mountHero()
    const mascot = wrapper.find('[data-testid="brand-mascot"]')
    expect(mascot.exists()).toBe(true)
    const img = mascot.find('img')
    expect(img.attributes('src')).toBe('/brand/mascot-logo.png')
    expect(img.attributes('alt')).toBeTruthy()
    // 装饰位不得变成第二个动作入口（单 CTA 纪律）
    expect(mascot.findAll('button')).toHaveLength(0)
    expect(mascot.element.tagName).toBe('SPAN')
  })
})
