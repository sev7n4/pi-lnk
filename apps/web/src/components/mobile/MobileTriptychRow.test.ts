import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileTriptychRow from './MobileTriptychRow.vue'

/**
 * 移动端三联叙事行的守卫（IA v4，2026-10-23 用户裁定「窄屏也要讲三联」）。
 *
 * 背景：桌面签名面（SignatureHero）的「左对话 → 中锚 → 右画布」是品牌叙事骨架，
 * 但移动端 stage 竖排后「对话 / 画布」标签随 `hidden lg:block` 整体消失 ⇒ 叙事
 * 断档。本组件把同一读序压成一行紧凑图标 legend；宿主是 hero 签名面（tone=signature）。
 *
 * 历史：三联原在 AgentSideRail【对话】空态（带头像/墨滴/slogan 的重版），
 * 2026-10-23 用户裁定「去掉对话页空态上面重复的部分（很丑）」⇒ 迁到 hero 并瘦身
 * 成纯图标行。迁移守卫（M10）钉在文件末尾：旧宿主不得回潮。
 *
 * 本测试锁九条不变量：
 *   ① 三标签齐全且**有序**（对话 → 锚定 → 画布）——竖排/乱序都丢读序
 *   ② 横向一行（root rule 显式 flex，且不是 column）
 *   ③ 中锚是**装饰叙事**：无 button、无 @click（真入口由宿主提供，两个会打架）
 *   ④ tone=signature ⇒ on-signature 家族；禁随主题翻转的面板令牌
 *   ⑤ tone=panel（默认）⇒ 面板令牌；禁签名面专用令牌
 *   ⑥ 禁裸字号（10/11/12/13px），走 --lnk-text-* 令牌
 *   ⑦ 零动画：hero 动效预算只三处（粒子/墨滴/锚脉冲），本组件不外扩
 *   ⑧ 锚 glyph 与 hero 落款印章同源同形（anchor-generate.png）
 *   ⑨ M10 迁移守卫：AgentSideRail 空态不再自带三联
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** 剥注释再断言（项目教训：源码静态断言会被注释命中 ⇒ 假红/假绿）。 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
}

const src = stripComments(readFileSync(join(HERE, 'MobileTriptychRow.vue'), 'utf8'))
const railSrc = stripComments(
  readFileSync(join(HERE, '../agent/AgentSideRail.vue'), 'utf8'),
)

/** 只取**这一条**规则的块体（到第一个 `}` 为止）——不用「切到文件尾」的宽判据。 */
function ruleBody(selector: string): string {
  const i = src.indexOf(selector)
  expect(i, `样式缺失：${selector}`).toBeGreaterThan(-1)
  const start = src.indexOf('{', i)
  const end = src.indexOf('}', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('MobileTriptychRow — 移动端三联叙事行', () => {
  it('① 三标签齐全且按「对话 → 锚定 → 画布」有序（乱序/竖排都丢读序）', () => {
    const wrapper = mount(MobileTriptychRow)
    const text = wrapper.text()
    const iTalk = text.indexOf('对话')
    const iAnchor = text.indexOf('锚定')
    const iCanvas = text.indexOf('画布')
    expect(iTalk, '缺「对话」标签').toBeGreaterThan(-1)
    expect(iAnchor, '缺「锚定」标签').toBeGreaterThan(-1)
    expect(iCanvas, '缺「画布」标签').toBeGreaterThan(-1)
    expect(iTalk, '读序必须 对话 → 锚定 → 画布').toBeLessThan(iAnchor)
    expect(iAnchor).toBeLessThan(iCanvas)
  })

  it('② 横向一行：root 规则显式 flex 且不是竖排', () => {
    const row = ruleBody('.lnk-triptych-row {')
    expect(row, '⛔ 三节点竖排会丢掉「左→中→右」的读序').not.toContain('flex-direction: column')
    expect(row, '三联一行必须显式横排，别靠 flex 默认值').toContain('display: flex')
  })

  it('③ 中锚是装饰叙事：无 button、无 @click，anchor 元素是 span', () => {
    const wrapper = mount(MobileTriptychRow)
    // 真创作入口由宿主提供（hero 的 168px 落款印章）——本组件再放一个按钮
    // 就会同一屏出现两个「开始创作」，用户点了没反应以为坏了
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(src, '装饰叙事不得挂点击').not.toContain('@click')
    const anchor = wrapper.find('.lnk-triptych-row__anchor')
    expect(anchor.exists()).toBe(true)
    expect(anchor.element.tagName).toBe('SPAN')
  })

  it('④ tone=signature ⇒ on-signature 家族，禁随主题翻转的面板令牌', () => {
    const wrapper = mount(MobileTriptychRow, { props: { tone: 'signature' } })
    expect(wrapper.classes()).toContain('lnk-triptych-row--signature')
    const sigBlock = src.slice(src.indexOf('.lnk-triptych-row--signature'))
    expect(sigBlock).toContain('var(--lnk-text-on-signature-muted)')
    expect(sigBlock).toContain('var(--lnk-accent-on-signature)')
    expect(
      sigBlock,
      '⛔ --lnk-text-muted 随主题翻转（浅色是 Ink 深灰），压恒深签名底约 1.9:1',
    ).not.toContain('var(--lnk-text-muted)')
    expect(
      sigBlock,
      '⛔ --lnk-accent 随主题翻转，签名面只用 accent-on-signature',
    ).not.toContain('var(--lnk-accent)')
  })

  it('⑤ tone=panel（默认）⇒ 面板令牌，禁签名面专用令牌', () => {
    const wrapper = mount(MobileTriptychRow)
    expect(wrapper.classes(), '默认 tone 必须是 panel——普通面板是多数场景').toContain(
      'lnk-triptych-row--panel',
    )
    const panelBlock = src.slice(
      src.indexOf('.lnk-triptych-row--panel'),
      src.indexOf('.lnk-triptych-row--signature'),
    )
    expect(panelBlock).toContain('var(--lnk-text-muted)')
    expect(panelBlock).toContain('var(--lnk-accent)')
    expect(
      panelBlock,
      '⛔ on-signature 家族是恒深签名面专用，压在翻转面板上会「颜色放反」',
    ).not.toContain('on-signature')
  })

  it('⑥ 字号一律走文本令牌：禁 10/11/12/13px 裸字号（CI 实锤过）', () => {
    const hits = [...src.matchAll(/font-size:\s*(10|11|12|13)px/g)].map((m) => m[0])
    expect(hits, `裸字号必须换成 --lnk-text-* 令牌：${hits.join(', ')}`).toEqual([])
    expect(src).toContain('font-size: var(--lnk-text-2xs)')
  })

  it('⑦ 零动画：hero 动效预算只三处（粒子/墨滴/锚脉冲），本组件不外扩', () => {
    expect(src, '叙事靠结构不靠动效；新增动画会超 hero 动效预算').not.toContain('@keyframes')
    expect(src, '同左：连 transition 都不要，纯静态 legend').not.toContain('animation')
    expect(src).not.toContain('transition')
  })

  it('⑧ 锚 glyph 与 hero 落款印章同源同形（anchor-generate.png + currentColor）', () => {
    const glyph = ruleBody('.lnk-triptych-row__glyph {')
    expect(glyph).toContain('anchor-generate.png')
    expect(glyph, 'currentColor 上色才能跟随 tone 令牌').toContain('currentColor')
  })
})

/**
 * ⑨ M10 迁移守卫：三联叙事已从 AgentSideRail【对话】空态迁到 hero。
 * 用户原话「去掉现在【对话页】空态上面重复的部分（很丑）」——旧宿主回潮
 * （重加 mascot/drops/slogan 重版）即失败；空态其余部分（persona 行/chips）保留。
 */
describe('M10 迁移守卫：AgentSideRail 空态不再自带三联', () => {
  it('旧三联痕迹全清（模板 / 样式 / 函数 / 品牌 import 都不剩）', () => {
    expect(railSrc, '模板：mobile-triptych 容器不得回潮').not.toContain('mobile-triptych')
    expect(railSrc, '样式：lnk-triptych* 规则块不得回潮').not.toContain('lnk-triptych')
    expect(railSrc, '脚本：focusComposerFromTriptych 只服务旧三联，应随迁出删除').not.toContain(
      'focusComposerFromTriptych',
    )
    expect(railSrc, 'BRAND_LOGO_URL 旧唯一用途是三联墨鱼；迁移后 import 应删除').not.toContain(
      'BRAND_LOGO_URL',
    )
  })

  it('空态其余部分保留：persona 行与样例 chips 仍在（删三联 ≠ 删空态）', () => {
    expect(railSrc).toContain('agent-composer-persona')
    expect(railSrc).toContain('agent-example-chip')
  })
})
