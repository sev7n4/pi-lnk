/**
 * 主页 / 个人中心 P3 设计走查的回归锁（2026-10-21）。
 *
 * 把本轮「走查复盘」发现固化成断言，防回潮：
 *   A. 个人中心卡片面禁用 surface-canvas —— 它曾与 App.vue 的页面底同值
 *      （App.vue 根节点 `bg-surface` = DEFAULT = --lnk-surface-canvas），
 *      卡片因此「融进页面」而非浮起；必须用 bg-surface-elevated（= --lnk-surface-raised，
 *      深色 #1f2430 / 浅色 #fff，双主题均比 canvas 页面底更亮 ⇒ 正确抬升）。
 *   B. 每页恰好一个 <h1>：主页唯一 h1 来自 SignatureHero 主标题；个人中心唯一 h1 是「个人中心」。
 *   C. 主页两区块栅格统一（我的画布 / 社区精选 同一组响应式列数）。
 *
 * 为什么用「读源码断言」而非渲染快照：这些都是静态结构不变量，源码断言更快、更稳，
 * 失败信息能直接指到文件；运行时交互另由组件自身测试覆盖。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8')

const PROFILE = read('ProfilePage.vue')
const HERO = read('../components/workflow/SignatureHero.vue')
const WORKFLOW = read('WorkflowPage.vue')
const SESSION_CARD = read('../components/workflow/SessionCard.vue')
const WORK_CARD = read('../components/works/WorkCard.vue')
const COVER_FALLBACK = read('../components/workflow/CanvasCoverFallback.vue')
const LAUNCHER = read('../components/workflow/CreativeLauncher.vue')

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

/**
 * 剥注释再断言（项目教训：源码静态断言会被注释命中 ⇒ 假红）。
 * 历史注释里提到旧组件名/旧写法是正常文档，不应判红；
 * 但断言「用上了新写法」时也必须剥注释，否则注释里的新名字会造成假绿。
 */
const stripComments = (src: string) =>
  src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w])\/\/.*$/gm, '$1')

describe('P3-A 个人中心卡片面令牌（禁 surface-canvas，须 elevated）', () => {
  it('⛔ ProfilePage 不得再用 bg-surface-canvas 作卡片/容器面', () => {
    expect(
      PROFILE,
      'bg-surface-canvas 与 App.vue 页面底同值 ⇒ 卡片失去层次。\n' +
        '应改用 bg-surface-elevated（--lnk-surface-raised，双主题浮起）。',
    ).not.toContain('bg-surface-canvas')
  })

  it('✅ 卡片面确实用了 bg-surface-elevated（防上一条因「全删干净」而假绿）', () => {
    expect(occurrences(PROFILE, 'bg-surface-elevated')).toBeGreaterThanOrEqual(3)
  })
})

describe('P3-B 每页恰好一个 <h1>', () => {
  const h1Count = (src: string) => (src.match(/<h1[\s>]/g) ?? []).length

  it('个人中心：ProfilePage 有且仅有一个 <h1>', () => {
    expect(h1Count(PROFILE), '个人中心应只有一个 h1（「个人中心」标题）').toBe(1)
  })

  it('主页：唯一 h1 来自 SignatureHero，WorkflowPage 自身不产 h1', () => {
    // 2026-10-22：h1 承载改为品牌 slogan 主行（BRAND_SLOGAN_MAIN）——
    // 用户裁定去掉旧标题「想象，落定成图」与问候语，slogan 是唯一叙事主角
    expect(h1Count(HERO), 'SignatureHero 的 slogan 主行应为 h1').toBe(1)
    expect(h1Count(WORKFLOW), 'WorkflowPage 不得自带 h1，否则主页出现两个 h1').toBe(0)
  })
})

describe('P3-C 主页两区块栅格统一', () => {
  const UNIFIED = 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'

  it('✅ 我的画布 + 社区精选（加载态 + 作品态）共用同一组响应式栅格', () => {
    expect(
      occurrences(WORKFLOW, UNIFIED),
      '三处栅格（我的画布 / 社区精选加载态 / 社区精选作品态）应完全一致',
    ).toBe(3)
  })

  it('⛔ 不得残留旧的「无 sm / 无 xl」分裂栅格', () => {
    expect(
      WORKFLOW,
      '社区精选曾用 grid-cols-2 … lg:grid-cols-4，与我的画布节奏断裂',
    ).not.toContain('grid grid-cols-2 gap-4 lg:grid-cols-4"')
  })
})

describe('P3-G 画布兜底 / 标题口径 / 墨圈（走查「没有设计品味」轮）', () => {
  const CARD = stripComments(SESSION_CARD)
  const HERO_SRC = stripComments(HERO)
  const FALLBACK_SRC = stripComments(COVER_FALLBACK)

  it('⛔ 画布兜底不再是用户头像位组件（紫底首字母读作「没加载的用户头像」）', () => {
    expect(
      CARD,
      'BrandPatternAvatar 是头像位语言；画布封面兜底应走 CanvasCoverFallback',
    ).not.toContain('BrandPatternAvatar')
    expect(CARD).toContain('CanvasCoverFallback')
  })

  it('⛔ 冒烟/测试 slug 不得泄漏成卡片标题', () => {
    expect(CARD, '标题必须过 displayCanvasTitle 口径').toContain('displayCanvasTitle')
  })

  it('hero 显色时刻是墨鱼π 品牌形象（BRAND_LOGO_URL 资产），不再是纯紫圆头像', () => {
    expect(HERO_SRC, '纯色圆 + 字符读作放错位置的装饰').not.toContain('BrandPatternAvatar')
    expect(HERO_SRC).toContain('data-testid="brand-mascot"')
    expect(HERO_SRC).toContain('BRAND_LOGO_URL')
  })

  it('slogan 来自 constants/brand 单一真相源，且小字不走品牌渐变（F-5）', () => {
    expect(HERO_SRC).toContain('BRAND_SLOGAN_MAIN')
    expect(HERO_SRC).not.toContain('bg-brand-gradient')
    expect(HERO_SRC).not.toContain('bg-clip-text')
  })

  it('兜底组件只消费 lnk-* 令牌（无裸 hex / 无 --neo-* / 无裸 rgba）', () => {
    expect(FALLBACK_SRC).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(FALLBACK_SRC).not.toContain('--neo-')
    expect(FALLBACK_SRC).not.toMatch(/rgba\(\s*\d/)
  })

  it('displayCanvasTitle 口径本身有单测兜底（防此处假绿）', () => {
    const util = read('../utils/displayCanvasTitle.test.ts')
    expect(util).toContain('layout-smoke-1792588745')
    expect(util).toContain('未命名画布')
  })
})

describe('P3-H 锚是唯一创作入口（走查「入口是锚」轮）', () => {
  const HERO_SRC = stripComments(HERO)
  const LAUNCHER_SRC = stripComments(LAUNCHER)

  it('hero 渲染锚入口（data-testid=ink-anchor），旧墨圈 stand-in 已退役', () => {
    expect(HERO_SRC, '2026-10-21 用户裁定「入口是锚」⇒ hero 必须有锚按钮').toContain(
      'data-testid="ink-anchor"',
    )
    expect(HERO_SRC, '自造 SVG 墨圈是锚资产就绪前的替身，真身到了应退役').not.toContain(
      'ink-enso',
    )
  })

  it('锚用项目既有品牌资产 anchor-generate.png（与画布坞生成按钮同源），不新造图标', () => {
    expect(HERO_SRC, '锚 glyph 必须走 assets/icons/anchor-generate.png').toContain(
      'anchor-generate.png',
    )
  })

  it('CTA 收敛：signature 与 default 两个 tone 分流明确（运行时无按钮由组件测试兜底）', () => {
    // 注意：按钮模板在源码中保留（v-if 只是运行时收敛，default tone 合法需要它），
    // 故此处锁「分流明确」而非「源码无按钮」；signature 运行时无内嵌按钮已由
    // SignatureHero.test.ts 的 findAll('button') 行为断言覆盖。
    expect(
      LAUNCHER_SRC,
      '输入框一个入口 + 锚一个入口 ⇒ 双 CTA 稀释锚的指引性；按钮应 v-if 收敛',
    ).toContain('v-if="tone !== \'signature\'"')
    expect(LAUNCHER_SRC, 'default tone 的「开始创作」按钮不得被误删').toContain('btn-primary')
  })

  it('锚的脉冲动效受 reduced-motion 守卫（与粒子/墨鱼同一 media 块）', () => {
    const mediaBlock = HERO_SRC.slice(HERO_SRC.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(mediaBlock).toContain('.lnk-anchor__ripple')
  })

  it('⛔ 底部两口与问候语已去除（用户 2026-10-22 裁定：纯净霸屏）', () => {
    expect(HERO_SRC, '「灵感 / 我的作品」两口已去掉').not.toContain('to="/community"')
    expect(HERO_SRC).not.toContain('to="/canvases"')
    expect(HERO_SRC, '问候语已去掉').not.toContain('data-greeting')
  })

  it('hero 霸屏铺满：无圆角卡片化 + 首屏高度（用户 2026-10-22 裁定）', () => {
    // 曾是 max-w-7xl 容器里的 rounded-2xl 卡片 ⇒ 浅色页面底从四边露白
    expect(HERO_SRC, 'hero 应四边贴视口，不得保留圆角卡片形态').not.toContain('rounded-2xl')
    expect(HERO_SRC).toContain('lnk-hero-screen')
    // 首屏高度必须扣掉顶栏（--neo-header-height，主题无关尺寸变量白名单成员）
    expect(HERO_SRC).toContain('calc(100dvh - var(--neo-header-height))')
    expect(HERO_SRC).toContain('calc(100vh - var(--neo-header-height))')
  })
})

describe('P3-I 媒体卡片语言统一（走查「两区块颜色割裂」轮）', () => {
  const CARD = stripComments(SESSION_CARD)
  const WORK = stripComments(WORK_CARD)

  it('画布卡与作品卡共用全局 .lnk-media-card（面 / 描边 / hover 单一真相源）', () => {
    expect(CARD, 'SessionCard 应挂全局卡片语言').toContain('lnk-media-card')
    expect(WORK, 'WorkCard 应挂全局卡片语言').toContain('lnk-media-card')
    // 各自 scoped 不得再写第二套 hover / 面语言（那正是「割裂」的成因）
    expect(CARD).not.toContain('border-color: var(--lnk-border-subtle)')
    expect(WORK).not.toContain('hover:border-accent')
    expect(WORK).not.toContain('hover:shadow-glow')
  })

  it('⛔ 作品卡封面不得用裸黑（black/xx），遮罩一律走 dim 令牌', () => {
    expect(WORK, 'black/xx 是硬编码黑；dim 令牌双主题自适应').not.toMatch(/\bblack\/\d/)
    expect(WORK).toContain('from-dim/80')
  })

  it('全局卡片语言本体在 main.css（与 btn 系同层 @layer components）', () => {
    const main = read('../styles/main.css')
    expect(main).toContain('.lnk-media-card')
    expect(main).toContain('.lnk-media-card:hover')
  })
})

describe('P3-J 签名画面叙事与材质（走查「叙事仪式感」轮，2026-10-22）', () => {
  const HERO_SRC = stripComments(HERO)
  const BRAND = read('../constants/brand.ts')

  it('slogan 重音走单一真相源：hero 引用 BRAND_SLOGAN_MAIN_ACCENT，且该词是主行子串', () => {
    expect(HERO_SRC, '强调词必须是常量，不是模板里写死的第二份文案').toContain(
      'BRAND_SLOGAN_MAIN_ACCENT',
    )
    expect(BRAND).toContain("export const BRAND_SLOGAN_MAIN_ACCENT = '锚定'")
    expect(BRAND, '强调词若不再是主行子串，切分渲染会静默丢失重音').toContain('锚定你的创意')
  })

  it('⛔ 产品术语退出品牌诗（composer / Agent 落地话术 / 旧指令话术）', () => {
    expect(HERO_SRC).not.toContain('composer')
    expect(HERO_SRC).not.toContain('Agent 把创作落地')
    expect(HERO_SRC).not.toContain('你下指令')
  })

  it('入口升为「门阶」pill：CTA 用 lnk-anchor__cta + 16px 字阶（不再 13px 弱色小字）', () => {
    expect(HERO_SRC).toContain('lnk-anchor__cta')
    expect(HERO_SRC).toContain('var(--lnk-text-md)')
  })

  it('锚是印章不是贴纸：浮起面板语言退场，墨环 / 墨晕 / 内阴线上位', () => {
    expect(HERO_SRC, '旧「黑影 + 白晕」读作贴上去的按钮').not.toContain('var(--lnk-hi-shadow)')
    expect(HERO_SRC).toContain('lnk-anchor__brush')
    expect(HERO_SRC).toContain('lnk-anchor__halo')
  })

  it('墨鱼π 进 slogan 字标（lnk-hero-lockup），不再是右上角孤立角标', () => {
    expect(HERO_SRC).toContain('lnk-hero-lockup')
    expect(HERO_SRC, '右上角绝对定位角标已退场').not.toContain('right-8 top-8')
  })
})

describe('P3-K 叙事动线与仪式动效（走查「叙事仪式感」轮·第二批，2026-10-22）', () => {
  const HERO_SRC = stripComments(HERO)

  it('输入站进三联：stage 承载输入框（空间即故事，不再大宽度孤条）', () => {
    expect(HERO_SRC, '叙事舞台容器').toContain('lnk-stage')
    expect(HERO_SRC, '输入站位（左「说」）').toContain('lnk-stage__talk')
  })

  it('墨点动效：落域 + 三颗墨点 + 落距同源（--lnk-drop-fall）', () => {
    expect(HERO_SRC).toContain('lnk-drop-zone')
    expect(HERO_SRC).toContain('lnk-ink-drop')
    expect(HERO_SRC, '落域高度与 keyframe 落距必须同源，否则墨点落不到锚顶').toContain(
      '--lnk-drop-fall',
    )
  })

  it('落款微时刻：stamp class + 六散 spark 在位', () => {
    expect(HERO_SRC).toContain('lnk-anchor--stamping')
    expect(HERO_SRC).toContain('lnk-anchor__spark')
  })

  it('⛔ 新动效载体全部进 reduced-motion 媒体块（漏守一个都算漏）', () => {
    const mediaBlock = HERO_SRC.slice(HERO_SRC.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(mediaBlock).toContain('.lnk-ink-drop')
    expect(mediaBlock).toContain('lnk-anchor--stamping')
    expect(mediaBlock).toContain('animation: none')
  })
})
