import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SignatureHero from './SignatureHero.vue'
import CreativeLauncher from './CreativeLauncher.vue'

// ⚠️ jsdom 环境下 `fileURLToPath()` 必须收字符串：全局 URL 是 jsdom 的实现，
// 把 URL **对象**传给 Node 的 fileURLToPath 会报 "The URL must be of scheme file"。
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 剥注释再断言（项目教训：源码静态断言会被注释命中 ⇒ 假红/假绿）。
 * 尤其「不得出现 X」这类否定断言：注释里解释「为什么不用 X」会把自己判红。
 */
const stripComments = (src: string) =>
  src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w])\/\/.*$/gm, '$1')

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

  it('墨鱼构成品牌字标：悬在落域顶（墨滴正上方），不再是右上角孤立角标', () => {
    const wrapper = mountHero()
    // 2026-10-22 起墨鱼不在 lockup 并排位、也不在右上角——它在落域顶，
    // 与「记住你的模样。」末行、墨滴、锚同一条垂直轴
    const mascot = wrapper.find('[data-testid="brand-mascot"]')
    expect(mascot.exists()).toBe(true)
    expect(mascot.element.closest('.lnk-drop-zone')).toBeTruthy()
    const src = readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8')
    expect(src).not.toContain('right-8 top-8')
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

  it('IA v4：窄屏完整复刻 PC 三叙事（对话标签组 / 墨鱼→墨滴→锚 / 画布标签组）', () => {
    const wrapper = mountHero()
    // ① 对话标签组：窄屏不再 hidden（PC 是 lg 才显示，窄屏曾是"只剩锚一个意象"）
    const stage = wrapper.find('.lnk-stage')
    expect(stage.exists()).toBe(true)
    const talkLabel = stage.text()
    expect(talkLabel).toContain('对话')
    expect(talkLabel).toContain('你说出想法')
    expect(talkLabel).toContain('画布')
    expect(talkLabel).toContain('墨鱼替你落墨')
    // ② 标签组不得带 hidden（窄屏隐藏 = 叙事断档）
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    expect(
      src,
      '⛔ 「对话」「画布」标签组必须窄屏可见（2026-10-23 用户裁定：窄屏完整复刻 PC 三叙事）',
    ).not.toMatch(/class="hidden[^"]*"\s*>\s*<p[^>]*>\s*(对话|画布)\s*</)
    expect(src).not.toMatch(/hidden[^"]*"[^>]*>\s*<p[^>]*>\s*(对话|画布)\s*</)
    // ③ 墨鱼→墨滴→锚 在窄屏也必须有位（落域不得 display:none）
    expect(src).not.toContain('.lnk-drop-zone {\n  display: none;')
    // ④ 窄屏尺寸组：锚盘 / 落程 / 墨鱼有压缩值，lg 还原 PC 尺寸
    expect(src).toContain('--lnk-anchor-size')
    expect(src).toContain('--lnk-drop-fall')
    expect(src).toContain('--lnk-mascot-size')
  })

  it('⛔ 不得有「三联 legend」旁挂行（用户 2026-10-23 裁定：多出来、违背品牌设计意图）', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    // 曾经的 MobileTriptychRow（对话-锚定-画布 小图标行）是叙事的二次转述，已删除
    expect(src, 'hero 里不得再引用三联 legend 组件').not.toContain('MobileTriptychRow')
    expect(src).not.toContain('triptych-row')
    // 也不得在别处复活：组件文件本身已删除
    expect(
      existsSync(join(HERE, '..', 'mobile', 'MobileTriptychRow.vue')),
      'MobileTriptychRow.vue 应已删除',
    ).toBe(false)
  })

  it('墨点动效：三颗墨点在锚上落域内，且受 reduced-motion 守卫', () => {
    const wrapper = mountHero()
    const drops = wrapper.findAll('.lnk-ink-drop')
    expect(drops).toHaveLength(3)
    // 落域高度与 keyframe 落距同源（--lnk-drop-fall / --lnk-drop-start），防两处漂移
    const src = readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8')
    expect(src).toContain('--lnk-drop-fall')
    expect(src).toContain('height: var(--lnk-drop-fall)')
    expect(src).toContain('calc(var(--lnk-drop-fall) - var(--lnk-drop-start))')
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

/**
 * 走查第三轮·第三批（2026-10-22 用户四条反馈）：
 * ① 墨鱼移到「记住你的模样」前；② 输入框紫环退场；③ 锚外环紫晕减重；④ 墨点改水滴。
 * 外加本轮用户实测发现的真 bug：锚盘走随主题翻转的 hi 令牌 ⇒ 浅色主题下反色沉进墨底。
 */
describe('SignatureHero · 反馈批次（墨鱼归位 / 输入框 / 紫晕 / 水滴）', () => {
  it('① 墨鱼悬在洒下的墨正上方：落域内、墨滴之前、与锚同轴', () => {
    const wrapper = mountHero()
    const mascot = wrapper.find('[data-testid="brand-mascot"]')
    expect(mascot.exists()).toBe(true)
    expect(mascot.find('img').attributes('src')).toBe('/brand/mascot-logo.png')
    // ⭐ 2026-10-22 无头浏览器实测：inline 在句中时图标中心距锚轴恒定 -157.2px
    //   （1280~1920 四档一致）——「在短语前」与「在墨滴上方」几何上不可兼得。
    //   故墨鱼悬在落域顶：DOM 序上必须在墨滴**之前**（上下关系由结构保证）。
    const zone = wrapper.find('.lnk-drop-zone')
    expect(zone.exists()).toBe(true)
    expect(zone.find('[data-testid="brand-mascot"]').exists()).toBe(true)
    const zoneHtml = zone.html()
    expect(
      zoneHtml.indexOf('brand-mascot'),
      '墨鱼必须是落域第一个元素（在墨滴上方）',
    ).toBeLessThan(zoneHtml.indexOf('lnk-ink-drop'))
    // 行内留等宽垫片：保住「记住你的模样。」独占居中末行的断行节奏
    const src = readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8')
    expect(src).toContain('BRAND_SLOGAN_MAIN_MASCOT_BEFORE')
    const unitBlock = src.slice(src.indexOf('.lnk-slogan-mascot {'))
    expect(unitBlock).toContain('white-space: nowrap')
    expect(src).toContain('lnk-slogan-mascot-gap')
  })

  it('② 输入框：signature 下紫环退场，聚焦改走中性柔雾（紫只属于锚）', () => {
    const launcherSrc = stripComments(readFileSync(join(HERE, 'CreativeLauncher.vue'), 'utf8'))
    const sigBlock = launcherSrc.slice(launcherSrc.indexOf('.lnk-launcher-signature {'))
    expect(sigBlock, '聚焦必须落在容器上（focus-within），不是 input 的 ring').toContain(':focus-within')
    expect(sigBlock, '紫 ring 与恒深墨底打架，且抢走锚的专属强调色').not.toContain(
      '--lnk-border-focus',
    )
    // 紫 ring 只保留在 default（浅底）分支做键盘可达性提示
    expect(launcherSrc).toContain('focus-visible:ring-[var(--lnk-border-focus)]')
    expect(
      launcherSrc,
      'signature 分支不得再挂 focus-visible 紫 ring',
    ).not.toContain('rounded-xl border-overlay/12 bg-surface-sunken focus-visible')
  })

  it('③ 锚外环紫晕减重：halo 收小到 -20px 且紫度对折', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    const halo = src.slice(src.indexOf('.lnk-anchor__halo {'))
    expect(halo).toContain('inset: -20px')
    expect(halo, '满强度 accent-subtle 会把整颗锚泡在紫里').toContain(
      'var(--lnk-accent-subtle) 50%',
    )
    // 环境光同样收力：28px/26% → 20px/16%
    const anchorRule = src.slice(src.indexOf('.lnk-anchor {'), src.indexOf('.lnk-anchor:hover'))
    expect(anchorRule).toContain('0 0 20px')
    expect(anchorRule).toContain('var(--lnk-accent) 16%')
  })

  it('④ 墨点是水滴不是圆点：尖头朝上 + 重力加速 + 从墨鱼正下方散开落入锚', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    const dropRule = src.slice(src.indexOf('.lnk-ink-drop {'))
    expect(dropRule, '0 角是尖头').toContain('border-radius: 0 50% 50% 50%')
    expect(dropRule, '重力：起步慢越落越快，匀速读不出「滴」').toContain(
      'cubic-bezier(0.42, 0, 0.85, 0.45)',
    )
    const kf = src.slice(src.indexOf('@keyframes lnk-ink-drop-fall'))
    expect(kf, 'rotate(45deg) 把尖头转到正上方').toContain('rotate(45deg)')
    expect(kf, '沿屏幕纵向拉长才是水滴').toContain('scale(0.82, 1.22)')
    // 起点 dx0 ≈ 0（墨鱼正下方），终点 dx1 散开（±48px，落在锚盘上）
    expect(kf).toContain('translate(var(--drop-dx0, 0), 0)')
    expect(kf).toContain('var(--drop-dx1')
    expect(kf, '落距 = 落域高 - 墨滴起点（同源换算，不写第二份数字）').toContain(
      'calc(var(--lnk-drop-fall) - var(--lnk-drop-start))',
    )
  })

  it('墨鱼 → 墨滴 → 锚同轴：三联两侧 minmax(0,1fr)，锚不再偏离 slogan 中轴', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    // 2026-10-22 实测：裸 1fr 的隐式 min 是 min-content，左右列不等宽把锚挤偏 30px
    expect(
      src,
      '两侧轨道必须 minmax(0,1fr) 才能等宽，锚才真正落在 slogan 中轴上',
    ).toContain('lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]')
  })

  it('锚盘走印章令牌（主题不变式），不再用随主题翻转的 hi 对', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    expect(src).toContain('var(--lnk-stamp-face-on-signature)')
    expect(src).toContain('var(--lnk-stamp-ink-on-signature)')
    // ⛔ hi 对随主题翻转（深主题白底 / 浅主题墨底），压在**不翻转**的恒深签名底上
    //   ⇒ 浅色主题下盘面翻成近黑 #17181d 压 #131318 ≈1.2:1，整颗锚沉进墨里。
    expect(src, 'hi-bg 随主题翻转，签名面上禁用').not.toContain('var(--lnk-hi-bg)')
    expect(src, 'hi-text 随主题翻转，签名面上禁用').not.toContain('var(--lnk-hi-text)')
    // 内阴线也必须跟着刻痕走，否则浅色主题下会描成白线
    const anchorRule = src.slice(src.indexOf('.lnk-anchor {'), src.indexOf('.lnk-anchor:hover'))
    expect(anchorRule).toContain('var(--lnk-stamp-ink-on-signature) 20%')
  })
})
