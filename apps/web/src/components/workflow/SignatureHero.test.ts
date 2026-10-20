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

  it('问候语是左上角小字，不再是首屏大标题', () => {
    const wrapper = mountHero()
    expect(wrapper.find('h1').exists()).toBe(false)
    const greeting = wrapper.find('[data-greeting]')
    expect(greeting.text()).toBe('下午好')
    expect(greeting.classes().join(' ')).toContain('text-sm')
  })
})
