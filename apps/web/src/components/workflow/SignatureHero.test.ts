import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SignatureHero from './SignatureHero.vue'
import CreativeLauncher from './CreativeLauncher.vue'

// ⚠️ jsdom 环境下 `fileURLToPath()` 必须收字符串：全局 URL 是 jsdom 的实现，
// 把 URL **对象**传给 Node 的 fileURLToPath 会报 "The URL must be of scheme file"。
const HERE = dirname(fileURLToPath(import.meta.url))

function mountHero() {
  // 2026-10-22 起 hero 无 RouterLink / 无 greeting prop（用户裁定纯净霸屏），裸挂载即可
  return mount(SignatureHero, {
    props: { modelValue: '' },
  })
}

describe('SignatureHero', () => {
  it('Enter 与锚触发同一个 create 动作（单 CTA）', async () => {
    const wrapper = mountHero()
    await wrapper.find('input').trigger('keydown.enter')
    await wrapper.find('[data-testid="ink-anchor"]').trigger('click')
    expect(wrapper.emitted('create')).toHaveLength(2)
  })

  it('锚是唯一动作入口（signature 下 composer 无内嵌按钮；hero 无第二个按钮）', () => {
    const wrapper = mountHero()
    // 2026-10-21 用户裁定「入口是锚」⇒ 全 hero 只有一个 button：锚本身。
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.attributes('data-testid')).toBe('ink-anchor')
    expect(buttons[0]!.attributes('aria-label')).toBe('点击锚，进入创作')
    const launcher = wrapper.findComponent(CreativeLauncher)
    expect(launcher.props('tone')).toBe('signature')
    expect(launcher.findAll('button')).toHaveLength(0)
  })

  it('旧「告诉我你的想法」guide 入口不存在', () => {
    const wrapper = mountHero()
    const texts = wrapper.findAll('button').map((b) => b.text())
    expect(texts.filter((t) => t.includes('告诉我你的想法'))).toHaveLength(0)
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

  it('粒子 / 墨鱼 / 锚脉冲动效都被 prefers-reduced-motion 降级', () => {
    // 注意：SFC 的 <style scoped> 不进入 wrapper.html()，必须读源码断言
    // 用 HERE（基于 import.meta.url 已在文件顶部验证可用的写法）拼接，避免 jsdom 的全局 URL 干扰
    const src = readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8')
    expect(src).toContain('@media (prefers-reduced-motion: reduce)')
    // 三个动效载体都必须被覆盖到，只停粒子不停锚脉冲仍算漏
    const mediaBlock = src.slice(src.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(mediaBlock).toContain('.lnk-ink-particles')
    expect(mediaBlock).toContain('.lnk-mascot')
    expect(mediaBlock).toContain('.lnk-anchor__ripple')
    expect(mediaBlock).toContain('animation: none')
  })

  it('问候语与旧标题已去除，slogan 主行是页面唯一 h1', () => {
    const wrapper = mountHero()
    // 2026-10-22 用户裁定：去掉「晚上好」问候与「想象，落定成图」旧标题，
    // 品牌 slogan 主行（BRAND_SLOGAN_MAIN）升级为 hero 唯一 h1。
    expect(wrapper.find('[data-greeting]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('想象，落定成图')
    const h1 = wrapper.find('h1')
    expect(h1.exists()).toBe(true)
    expect(h1.text()).toContain('墨鱼π，锚定你的创意')
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

  it('墨鱼在 slogan 旁构成品牌字标（lnk-hero-lockup），不再是右上角孤立角标', () => {
    const wrapper = mountHero()
    const lockup = wrapper.find('.lnk-hero-lockup')
    expect(lockup.exists()).toBe(true)
    expect(lockup.find('[data-testid="brand-mascot"]').exists()).toBe(true)
  })

  it('slogan 主行切分渲染后仍等于单一真相源全文，「锚定」是唯一强调词', () => {
    const wrapper = mountHero()
    const h1 = wrapper.find('h1')
    // 切分渲染不得改写文案：拼接结果必须逐字等于 BRAND_SLOGAN_MAIN
    expect(h1.text()).toBe('墨鱼π，锚定你的创意，一点一滴洒在画布，让画布记住你的模样。')
    const accent = wrapper.find('.lnk-slogan-accent')
    expect(accent.exists()).toBe(true)
    expect(accent.text()).toBe('锚定')
    // 强调色走签名面专用令牌（不是随主题翻转的 accent-text）。
    // ⚠️ scoped 样式不进 wrapper.html()，必须读源码断言（同文件既有教训）
    const src = readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8')
    expect(src).toContain('var(--lnk-accent-on-signature)')
  })

  it('CTA 是「门阶」pill：16px 实色 on-signature（不再 13px 弱色小字）', () => {
    const wrapper = mountHero()
    const cta = wrapper.find('.lnk-anchor__cta')
    expect(cta.exists()).toBe(true)
    expect(cta.text()).toBe('点击锚，进入创作')
    const src = readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8')
    const ctaBlock = src.slice(src.indexOf('.lnk-anchor__cta {'))
    expect(ctaBlock).toContain('var(--lnk-text-md)')
    expect(ctaBlock).toContain('var(--lnk-text-on-signature)')
  })

  it('锚是印章不是贴纸：浮起面板语言退场，墨环 / 墨晕 / 内阴线上位', () => {
    const src = readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8')
    // 旧语言（黑影 + 白晕）已从锚上移除；新材质三件套在位
    expect(src).not.toContain('var(--lnk-hi-shadow)')
    expect(src).toContain('lnk-anchor__brush')
    expect(src).toContain('lnk-anchor__halo')
    expect(src).toContain('inset 0 0 0 1px')
  })

  it('⛔ 产品术语退出品牌诗（叙事文案归位）', () => {
    const wrapper = mountHero()
    const text = wrapper.text()
    expect(text).not.toContain('composer')
    expect(text).not.toContain('Agent 把创作落地')
    expect(text).not.toContain('你下指令')
    expect(text).toContain('你说出想法')
    expect(text).toContain('墨鱼替你落墨')
  })

  it('叙事动线：输入站进三联（stage 同时承载输入框与锚，不再分离）', () => {
    const wrapper = mountHero()
    const stage = wrapper.find('.lnk-stage')
    expect(stage.exists()).toBe(true)
    // 「对话」（输入框）与「锚」必须在同一舞台容器内——空间即故事
    expect(stage.findComponent(CreativeLauncher).exists()).toBe(true)
    expect(stage.find('[data-testid="ink-anchor"]').exists()).toBe(true)
  })

  it('墨点动效：三颗墨点在锚上落域内，且受 reduced-motion 守卫', () => {
    const wrapper = mountHero()
    const drops = wrapper.findAll('.lnk-ink-drop')
    expect(drops).toHaveLength(3)
    // 落距与落域高度同源（--lnk-drop-fall），防两处漂移导致墨点落不到锚顶
    const src = readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8')
    expect(src).toContain('--lnk-drop-fall')
    expect(src).toContain('height: var(--lnk-drop-fall)')
    expect(src).toContain('translate(var(--drop-dx, 0), var(--lnk-drop-fall))')
    const mediaBlock = src.slice(src.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(mediaBlock).toContain('.lnk-ink-drop')
  })

  it('落款微时刻：点锚即触发 stamp class，600ms 后自摘（连点不卡死）', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountHero()
      const anchor = wrapper.find('[data-testid="ink-anchor"]')
      await anchor.trigger('click')
      expect(wrapper.emitted('create')).toHaveLength(1)
      expect(anchor.classes()).toContain('lnk-anchor--stamping')
      vi.advanceTimersByTime(700)
      await wrapper.vm.$nextTick()
      expect(anchor.classes()).not.toContain('lnk-anchor--stamping')
    } finally {
      vi.useRealTimers()
    }
  })

  it('盖章瞬间六颗墨点四散（spark 带各自方向）', () => {
    const wrapper = mountHero()
    const sparks = wrapper.findAll('.lnk-anchor__spark')
    expect(sparks).toHaveLength(6)
    // 方向必须各自不同，否则六颗墨点会叠成一条线
    const dirs = sparks.map((s) => s.attributes('style'))
    expect(new Set(dirs).size).toBe(6)
  })
})
