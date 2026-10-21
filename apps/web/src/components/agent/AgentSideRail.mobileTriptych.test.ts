import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 移动端【对话】空态三联叙事头的守卫（2026-10-22 用户裁定「窄屏也要讲三联」）。
 *
 * 背景：桌面签名面（SignatureHero）的「左对话 → 中锚定 → 右画布」是品牌叙事骨架，
 * 但**移动端根本走不到那个页面**——`WorkflowPage` 在移动端会 `location.assign`
 * 直接跳进最近项目的画布页（未登录/接口失败才留在主站）。所以窄屏的叙事落点是
 * 画布页【对话】页签的空态（`.agent-composer-firstscreen`），不是 hero。
 *
 * 本测试锁四条不变量：
 *   ① 三联只在移动端出现（lg:hidden），桌面侧栏零变化（persona 行反向上锁）
 *   ② 三联**横向一行**（竖排会丢掉「左→中→右」的读序，那正是它唯一要传达的东西）
 *   ③ 点锚**只进输入态、绝不提交**（发送意图必须显式，提交归 composer 发送键）
 *   ④ 令牌纪律：挂在随主题翻转的对话面板上 ⇒ 禁签名面专用的 on-signature 家族
 */

const rail = readFileSync(resolve(__dirname, 'AgentSideRail.vue'), 'utf8')

/** 剔除三种注释形态，防「注释里正面记录」造成的假红/假绿。 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')
    })
    .join('\n')
}

const src = stripComments(rail)

/**
 * 只取**这一条**规则的块体（到第一个 `}` 为止）。
 * ⛔ 不能用 styleBlock 那种「切到文件尾」的宽判据：`.lnk-triptych__node` 内部
 * 本来就是竖排（图标在上、文字在下），宽判据会把它误判成「三联竖排」——
 * 假红，且真回潮时反而看不清是谁竖排了。
 */
function ruleBody(selector: string): string {
  const i = src.indexOf(selector)
  expect(i, `样式缺失：${selector}`).toBeGreaterThan(-1)
  const start = src.indexOf('{', i)
  const end = src.indexOf('}', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('AgentSideRail — 移动端三联叙事头', () => {
  it('① 三联只在移动端出现（lg:hidden），桌面 persona 行反向保留', () => {
    expect(src).toContain('data-testid="mobile-triptych"')
    expect(src, '三联必须 lg:hidden —— 桌面侧栏窄且已有 persona 行').toContain(
      'class="lnk-triptych mb-4 lg:hidden"',
    )
    expect(
      src,
      '桌面 persona 行必须 hidden lg:block —— 否则移动端会出现两行重复的引导文案',
    ).toContain('class="agent-composer-persona hidden text-center text-[12px] leading-relaxed lg:block"')
  })

  it('② 三联横向一行：三节点齐全（对话 / 锚 / 画布），且不是竖排', () => {
    const row = ruleBody('.lnk-triptych__row {')
    expect(row, '⛔ 三节点竖排会丢掉「左→中→右」的读序').not.toContain('flex-direction: column')
    expect(row, '三联一行必须显式横排，别靠 flex 默认值').toContain('display: flex')
    const triptych = src.slice(src.indexOf('data-testid="mobile-triptych"'))
    const rowTpl = triptych.slice(0, triptych.indexOf('lnk-triptych__slogan'))
    expect(rowTpl).toContain('对话')
    expect(rowTpl).toContain('锚定')
    expect(rowTpl).toContain('画布')
  })

  it('③ 锚是按钮，点击只聚焦输入框、绝不提交', () => {
    expect(src).toContain('data-testid="mobile-triptych-anchor"')
    expect(src).toContain('@click="focusComposerFromTriptych"')
    const fn = src.slice(src.indexOf('function focusComposerFromTriptych'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body, '点锚必须进入输入态').toContain('composerRef.value?.focus()')
    expect(
      body,
      '⛔ 点锚不得提交：发送意图必须显式表达，提交归 composer 发送键（两个入口会打架）',
    ).not.toContain('sendMessage')
  })

  it('④ 令牌纪律：挂在随主题翻转的对话面板上，禁签名面专用 on-signature 家族', () => {
    const block = src.slice(src.indexOf('.lnk-triptych {'), src.indexOf('.lnk-triptych__slogan-sub'))
    expect(block).toContain('var(--lnk-accent)')
    expect(
      block,
      '⛔ on-signature 家族是恒深签名面专用，压在翻转的对话面板上会重演「颜色放反」',
    ).not.toContain('on-signature')
  })

  it('墨鱼走品牌 SSOT，不在组件里写死第二份路径', () => {
    expect(src).toContain("import { BRAND_LOGO_URL } from '@/constants/brand'")
    expect(src).toContain(':src="BRAND_LOGO_URL"')
  })

  it('字号一律走文本令牌：AgentSideRail 禁 10/11/12/13px 裸字号（CI 实锤过）', () => {
    // 真事：首版三联写了 font-size: 11px/12px，CI 的 text-token-guard 直接红
    // （AgentSideRail 全域禁裸字号，必须走 --lnk-text-* 令牌）。
    const hits = [...rail.matchAll(/font-size:\s*(10|11|12|13)px/g)].map((m) => m[0])
    expect(hits, `裸字号必须换成 --lnk-text-* 令牌：${hits.join(', ')}`).toEqual([])
  })

  it('墨滴动效受 reduced-motion 守卫（漏守即为无障碍回潮）', () => {
    const media = src.slice(src.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(media).toContain('.lnk-triptych__drop')
    expect(media).toContain('animation: none')
  })
})
