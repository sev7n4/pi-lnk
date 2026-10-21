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
const COVER_FALLBACK = read('../components/workflow/CanvasCoverFallback.vue')

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
    expect(h1Count(HERO), 'SignatureHero 主标题「想象，落定成图」应为 h1').toBe(1)
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
