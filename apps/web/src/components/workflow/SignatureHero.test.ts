import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SignatureHero from './SignatureHero.vue'
import SlideToCreate from './SlideToCreate.vue'

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
  // 2026-10-24 起 hero 无 modelValue prop（「描述你的创意」输入框整体退场，
  // 创作入口 = 锚 + 滑动解锁），裸挂载即可。
  return mount(SignatureHero)
}

describe('SignatureHero', () => {
  it('滑动解锁与锚触发同一个 create 动作（双入口同源）', async () => {
    const wrapper = mountHero()
    // 2026-10-24 用户裁定·第 5 点：输入框退场，创作入口 = 锚 + 滑动解锁 ⇒
    // 两个入口必须发同一个 create（不是两个不同的动作）。
    const knob = wrapper.find('.lnk-slide__knob')
    expect(knob.exists()).toBe(true)
    await knob.trigger('keydown', { key: 'Enter' })
    await wrapper.find('[data-testid="ink-anchor"]').trigger('click')
    expect(wrapper.emitted('create')).toHaveLength(2)
  })

  it('创作入口恰为两个：锚 + 滑动解锁把手（无第三个按钮）', () => {
    const wrapper = mountHero()
    // 2026-10-24 用户裁定·第 5 点：输入框退场后，hero 上的动作入口恰两个——
    // 锚（印章）与滑动解锁把手；两者都必须可达，且没有多余按钮。
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(2)
    // ⛔ 不按 DOM 顺序断言：滑条在左列、锚在中列 ⇒ 滑条按钮在前
    const anchor = wrapper.find('[data-testid="ink-anchor"]')
    expect(anchor.exists()).toBe(true)
    expect(anchor.attributes('aria-label')).toBe('点击锚，进入创作')
    const knob = wrapper.find('.lnk-slide__knob')
    expect(knob.exists()).toBe(true)
    expect(knob.attributes('aria-label')).toBe('滑动进入创作')
    // 滑动组件本体在位（双入口之二）
    expect(wrapper.findComponent(SlideToCreate).exists()).toBe(true)
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

  it('滑动条在深底上走签名面令牌（不用浅色主题文字令牌）', () => {
    // 2026-10-24 用户裁定·第 5 点：输入框退场 ⇒ 断言对象换成滑动条：
    // 它坐在恒深签名底上 ⇒ 只许 on-signature / stamp 家族令牌。
    const src = stripComments(readFileSync(join(HERE, 'SlideToCreate.vue'), 'utf8'))
    expect(src).toContain('var(--lnk-surface-on-signature)')
    expect(src).toContain('var(--lnk-stamp-face-on-signature)')
    expect(src).toContain('var(--lnk-stamp-ink-on-signature)')
    // ⛔ 随主题翻转的令牌禁入（浅色主题下会翻成近黑、沉进墨里）
    expect(src).not.toContain('--lnk-hi-bg')
    expect(src).not.toContain('--lnk-hi-text')
    expect(src).not.toContain('--lnk-accent-text')
    expect(src).not.toContain('text-fg-3')
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
    expect(text).toContain('墨鱼π，锚定你的创意，一点一滴洒在画布，让世界记住你的模样。')
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
    expect(h1.text()).toBe('墨鱼π，锚定你的创意，一点一滴洒在画布，让世界记住你的模样。')
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
    // 2026-10-24 用户裁定·第 3 点：右列副文案 = 「墨鱼π替你落墨」
    // （「画布记住你的模样」退场——主 h1 slogan 已有「让世界记住你的模样」，不重复）
    expect(text).toContain('墨鱼π')
    expect(text).toContain('替你落墨')
    expect(text).not.toContain('画布记住你的模样')
  })

  it('叙事动线：滑动解锁进三联（stage 同时承载滑动条与锚，不再分离）', () => {
    const wrapper = mountHero()
    const stage = wrapper.find('.lnk-stage')
    expect(stage.exists()).toBe(true)
    // 「对话」（滑动解锁）与「锚」必须在同一舞台容器内——空间即故事
    expect(stage.findComponent(SlideToCreate).exists()).toBe(true)
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
    expect(talkLabel).toContain('墨鱼π')
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

  it('IA v4：窄屏三叙事横排（左右结构），与 PC 端同构', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    // ① 窄屏栅格：三列 areas（对话 | 锚 | 画布）+ 滑动解锁独占第二行
    expect(src, '窄屏必须是三列横排（areas）').toContain(
      "'talk anchor canvas'\n    'slide slide slide'",
    )
    // ② 三列各自是 stage 的 grid item（列名不能丢）
    for (const cls of ['lnk-talk-label', 'lnk-col-anchor', 'lnk-col-canvas', 'lnk-talk-slide']) {
      expect(src, `${cls} 必须在叙事舞台内`).toContain(cls)
    }
    // ③ 左列用 display:contents：否则 talk 列的子元素（滑动条）排不进 areas 第二行
    expect(src, '窄屏左列须 display:contents（滑动条才能落到第二行）').toMatch(
      /\.lnk-col-talk\s*\{[^}]*display:\s*contents/,
    )
    // ④ 桌面恢复：滑动条回到左列内（talk 列 = 内容列 + 装饰线列两格；
    //    窄屏那套 display:contents 只对 <lg 生效）
    expect(src, '桌面左列须恢复为 grid 两格（内容 | 装饰线）').toMatch(
      /\.lnk-col-talk\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/,
    )
    expect(src, '窄屏左列才用 display:contents（滑动条落到第二行）').toMatch(
      /\.lnk-col-talk\s*\{[^}]*display:\s*contents/,
    )
    // ⑤ 中列宽度锁死 = 锚盘宽（否则 CTA 文字撑宽中列 ⇒ 左右列被压扁、三叙事散架）
    expect(src, '中列宽度须锁死（CTA 不得撑宽中列）').toMatch(
      /\.lnk-col-anchor\s*\{[^}]*width:\s*var\(--lnk-anchor-size\)/,
    )
    // ⑥ 窄屏 CTA 必须收窄（桌面那套 187px 会撑爆中列）
    expect(src, '窄屏 CTA 字号须降档').toMatch(
      /\.lnk-anchor__cta\s*\{[^}]*font-size:\s*var\(--lnk-text-sm\)/,
    )
  })

  it('IA v4：slogan 窄屏 3 行（lead 1 行 + 主行 2 行），并改「让世界记住你的模样」', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    // ① 字号：lead 降 base(14px)、主行降 xl(20px)——窄屏 5 行太占
    expect(src, 'lead 窄屏字号须为 base').toMatch(
      /class="[^"]*text-\[length:var\(--lnk-text-base\)\][^"]*"\s*>\s*\{\{ BRAND_SLOGAN_LEAD/,
    )
    expect(src, '主行窄屏字号须为 xl').toContain('text-[length:var(--lnk-text-xl)] leading-[var(--lnk-lh-xl)]')
    // ② 文案：两端共用的单一真相源（constants/brand）
    // ⚠️ 剥注释后再断言：迁移说明里写着旧文案（记录历史决策），裸读会把注释当字面量 ⇒ 假红
    const brand = stripComments(readFileSync(join(HERE, '..', '..', 'constants', 'brand.ts'), 'utf8'))
    expect(brand, 'slogan 主行必须是「让世界记住你的模样」').toContain(
      '让世界记住你的模样',
    )
    expect(brand, '旧文案已撤').not.toContain('让画布记住你的模样')
    // ③ inline 墨鱼位仍须是主行子串（改文案后不能漂移，否则墨鱼静默消失）
    expect(brand).toContain("export const BRAND_SLOGAN_MAIN_MASCOT_BEFORE = '记住你的模样'")
  })

  it('⛔ 桌面端（lg）不得被窄屏改动牵连（用户 2026-10-23 提醒）', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    // 背景：把移动端改成左右结构时，PC 端一度被连带破坏（实测 1440×900，基线 = 移动端改动前）：
    //   · 窄屏的 grid-area: talk/anchor/canvas 残留 ⇒ lg 下 grid-template-areas:none
    //     让所有 item 退化成 auto 放置 ⇒ 三列错乱（中列被挤到右侧、右列与中列重叠、
    //     锚偏离 slogan 中轴 348px）；
    //   · 装饰线被留在列内 ⇒ PC 上跑到输入框下方 / 与文字组同 x（竖排了）；
    //   · 中列被锁成锚盘宽（168）⇒ 原设计是 CTA 自然宽（186），CTA 溢出中列。
    // 判据：lg 断点里这四条必须都在（逐条对应上面的实测缺陷）。
    const lg = src.slice(src.indexOf('@media (min-width: 1024px)'))
    expect(lg, 'lg 必须清掉窄屏的 grid-area 引用').toMatch(
      /\.lnk-talk-label,\s*\.lnk-talk-slide,\s*\.lnk-col-anchor,\s*\.lnk-col-canvas\s*\{[^}]*grid-area:\s*auto/,
    )
    expect(lg, 'lg 中列必须解锁（width:auto ⇒ 回到原设计的 CTA 自然宽）').toMatch(
      /\.lnk-col-anchor\s*\{[^}]*width:\s*auto/,
    )
    expect(lg, 'lg 右列必须占满 1fr 格（width:100% ≡ 原设计的 w-full）').toMatch(
      /\.lnk-col-canvas\s*\{[^}]*width:\s*100%/,
    )
    expect(lg, 'lg 两侧必须 minmax(0,1fr)（否则锚偏离 slogan 中轴）').toContain(
      'grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)',
    )
    // 装饰线在 lg 下必须横排定位（左侧线的 grid-area 指向 talk 列第二格）
    expect(src, '装饰线须有语义 class（lg 下按列定位）').toContain('lnk-deco-left')
    expect(src, '装饰线须有语义 class（lg 下按列定位）').toContain('lnk-deco-right')
    expect(lg, '左装饰线须在 talk 列右侧、与列中线齐').toMatch(
      /\.lnk-deco-left\s*\{[^}]*grid-area:\s*1 \/ 2 \/ 3 \/ 3/,
    )
    expect(lg, '右装饰线须在右列左侧、与列中线齐').toMatch(
      /\.lnk-deco-right\s*\{[^}]*grid-area:\s*1 \/ 1 \/ 2 \/ 2/,
    )
  })

  it('IA v4：窄屏副文案不得出现孤字换行（实测「画布记住你的模样」7 字占 96px > 列宽 93px）', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    // 窄屏右列宽 = (342 - 132 - 24) / 2 = 93px；7 个 CJK 字 @11px ≈ 88px 才放得下
    // （实测 12px 时每字 13.7px ⇒ 96px ⇒ 差 3px 被拆成「画布记住你的 / 样」孤字）。
    // 2026-10-24 用户裁定·第 3 点后副文案改为「墨鱼π / 替你落墨」（更短），
    // 但字号降档的纪律不变 ⇒ 仍须断言 2xs(11px) + 窄屏断行点。
    expect(src, '窄屏副文案须用 2xs(11px)').toMatch(
      /class="mt-2 text-\[length:var\(--lnk-text-2xs\)\][^"]*"[\s\S]{0,200}替你落墨/,
    )
    // 窄屏断行点保留在「墨鱼π」之后 ⇒ 桌面端仍读作一句「墨鱼π替你落墨」
    expect(src, '窄屏须在「墨鱼π」后断行').toContain('墨鱼π<br class="lg:hidden">替你落墨')
  })

  it('IA v4：底部留出公司信息位（内容待补，位置先定）', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    expect(src, 'hero 底部须有公司信息预留位').toContain('lnk-company-slot')
    expect(src, '预留位须有确定高度（内容到位时不挤压上方叙事带）').toMatch(
      /\.lnk-company-slot\s*\{[^}]*min-height:/,
    )
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
    // 2026-10-23：栅格改由 scoped CSS 承载（Tailwind 任意值表达不了 grid-template-areas，
    // 且与 scoped 规则同优先级靠顺序决胜太脆）⇒ 判据跟到 CSS 的 grid-template-columns。
    expect(
      src,
      '两侧轨道必须 minmax(0,1fr) 才能等宽，锚才真正落在 slogan 中轴上',
    ).toContain('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)')
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

/**
 * 2026-10-23/24 用户六点裁定的回归锁（品牌页移动端）：
 *   ③ 右列副文案 = 「墨鱼π替你落墨」（「画布记住你的模样」退场）；
 *   ④ 【对话】↔【锚】↔【画布】的连接线在窄屏补齐（PC 端几何零变化）；
 *   ⑤ 「描述你的创意」输入框整体退场 ⇒ 创作入口 = 锚 + 滑动解锁（双入口）。
 * 另：① 品牌字标短名、② 品牌页去主题切换/积分（见 brand.ts / AppHeader / AccountChrome）。
 */
describe('SignatureHero · 用户六点（品牌页移动端）', () => {
  it('③ 右列副文案是「墨鱼π替你落墨」，「画布记住你的模样」已退场', () => {
    const wrapper = mountHero()
    const text = wrapper.text()
    expect(text).toContain('墨鱼π')
    expect(text).toContain('替你落墨')
    expect(text, '副文案退场（与主 h1 的「让世界记住你的模样」不重复）').not.toContain(
      '画布记住你的模样',
    )
    // 桌面端仍读作一句（窄屏才断行）
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    expect(src).toContain('墨鱼π<br class="lg:hidden">替你落墨')
  })

  it('④ 窄屏补连接线：锚两侧各一条，桌面端隐藏（PC 几何零变化）', () => {
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    // 两条窄屏专用连接线在 DOM 里（锚列内，左右各一）
    expect(src).toContain('lnk-anchor__link--left')
    expect(src).toContain('lnk-anchor__link--right')
    // 绝对定位：不占 grid 轨道 ⇒ 不挤压窄屏三列（窄屏右列实测仅 93px）
    const linkBlock = src.slice(src.indexOf('.lnk-anchor__link {'))
    expect(linkBlock, '连接线须绝对定位（不改列宽）').toContain('position: absolute')
    // 桌面端隐藏这两条（PC 用列内 deco 线）
    expect(linkBlock).toMatch(/@media \(min-width: 1024px\)\s*\{[^}]*\.lnk-anchor__link\s*\{[^}]*display:\s*none/)
    // PC 端那两条列内 deco 线仍在（桌面几何零变化）
    expect(src).toContain('lnk-deco-left')
    expect(src).toContain('lnk-deco-right')
  })

  it('⑤ 输入框整体退场：hero 里不再有输入框 / 不再有 modelValue 契约', () => {
    const wrapper = mountHero()
    expect(wrapper.find('input').exists(), '「描述你的创意」输入框已退场').toBe(false)
    expect(wrapper.find('textarea').exists()).toBe(false)
    const src = stripComments(readFileSync(join(HERE, 'SignatureHero.vue'), 'utf8'))
    expect(src, 'hero 不得再引 CreativeLauncher').not.toContain('CreativeLauncher')
    expect(src, 'hero 不得再有 modelValue 契约').not.toContain('modelValue')
    // 创作入口 = 锚 + 滑动解锁，两者同发 create
    expect(wrapper.find('[data-testid="ink-anchor"]').exists()).toBe(true)
    expect(wrapper.findComponent(SlideToCreate).exists()).toBe(true)
  })

  it('⑤ 滑动解锁把手机：把手是真 button（键盘可达）+ 触发同一个 create', async () => {
    const wrapper = mountHero()
    const knob = wrapper.find('.lnk-slide__knob')
    expect(knob.exists()).toBe(true)
    expect(knob.element.tagName).toBe('BUTTON')
    // 空格 / 回车等效于滑满（键盘用户不必拖拽）
    await knob.trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('create')).toHaveLength(1)
  })
})
