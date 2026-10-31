import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 移动端「页签失灵」回归守卫（2026-10-19 真机反馈）：
 * 全屏遮罩 z-index（95/96）> 页签（80），遮罩若 `inset: 0` 盖住页签区，
 * 点页签只会触发遮罩 @click.self 自关、不切页签（第一次点没反应、第二次才生效）。
 * 修复方式：遮罩 bottom 让开页签 —— `bottom: var(--lnk-tabbar-h, 56px)`。
 *
 * 2026-10-20 起范围扩展为「贴底容器跨页签泄漏」家族守卫：
 * 画布/发现/我的页签下，对话 chrome（系统层卡片）不得残留在透明壳里浮在页面上。
 * 2026-10-21 起第三代形态：系统层容器「默认全隐 + 白名单放行」——断言守护容器规则、
 * 白名单类落位（canvas-always 2026-10-28 随浮卡退役、canvas-with-composer 2026-10-29
 * 随对话流外 ask 卡退役，白名单现已全部清零）、旧逐卡选择器不得回归、容器内卡片位置不变量。
 *
 * 断言只作用于提取出的 CSS 规则块内部（不含注释），避免「记录被删历史」的
 * 注释文本污染否定断言；每个否定断言都配有块存在性 + 关键属性的有效性断言。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SFC_PATH = join(HERE, 'AgentSideRail.vue')

/** 提取 `selector { ... }` 规则块（本组件遮罩规则无嵌套，首个 `}` 即块尾） */
function extractRuleBlock(sfc: string, selector: string): string {
  const at = sfc.indexOf(selector)
  if (at < 0) return ''
  const open = sfc.indexOf('{', at)
  const close = sfc.indexOf('}', open)
  if (open < 0 || close < 0) return ''
  return sfc.slice(open + 1, close)
}

describe('mobile mask never covers the tab bar (页签失灵回归守卫)', () => {
  const sfc = readFileSync(SFC_PATH, 'utf8')

  it('thread-history-layer 遮罩 bottom 让开页签区', () => {
    const block = extractRuleBlock(sfc, '.thread-history-layer')
    // 有效性：块存在且是 fixed 定位（防止选择器改名导致断言空转）
    expect(block).toContain('position: fixed')
    // 让开页签：bottom 走 --lnk-tabbar-h，兜底 56px（变量未发布时也不得回落成盖住页签）
    expect(block).toContain('bottom: var(--lnk-tabbar-h, 56px)')
    // 不许再出现整屏 inset: 0
    expect(block).not.toMatch(/inset:\s*0/)
  })

  it('切页签时自动收起对话历史面板（mobileAppTab watch）', () => {
    // watch 内必须收历史面板，否则面板开着切页签会挂在页面上。
    // 2026-10-26 规格收敛 v2：项目抽屉（sessionDrawerOpen）已退役（≡ = 返回创作首页），
    // 反向断言钉死它不得回流。
    expect(sfc).toContain('mobileThreadHistoryOpen.value) closeThreadHistory()')
    expect(sfc, '项目抽屉已退役（D10），不得回流').not.toContain('sessionDrawerOpen')
  })

  it('发现/我的页签：贴底容器（Teleport 到 body）自身隐藏，整页不得盖住页签页', () => {
    // 回归 2026-10-20：dialog 的 aside hidden 管不到 Teleport 内容，z 又高于 main.z-10，
    // 从对话/画布切到发现/我的会整页覆盖或裸露状态行。由容器自身 v-show 收口。
    expect(sfc).toContain('v-show="open && !railHiddenByTab"')
    expect(sfc).toContain('mobileAppTab === \'discover\' || props.mobileAppTab === \'mine\'')
  })

  it('画布视图：系统层容器默认全隐（根治：漏登记不再静默）', () => {
    // 回归 2026-10-21：系统层曾逐卡往 is-canvas-view 清单登记，漏了三次
    //（#496 状态行 / #516 ask 卡+取消回执 / 更早 railHiddenByTab），失败模式静默、
    // 每次都要真机截图才发现。现翻转默认值：容器在画布视图默认 display:none——
    // 新卡片进层即安全；需要露头的显式加白名单类（漏放行 = 立刻可见的功能缺失）。
    const block = extractRuleBlock(sfc, '.agent-panel-mobile-dock.is-canvas-view .agent-system-layer')
    expect(block).toContain('display: none')
  })

  it('画布视图：canvas-always 白名单已随对话流外浮卡下线退役（死规则不残留）', () => {
    // 根治规格 2026-10-28：propose 决策点 = 时间线内联卡 + 画布节点内联面，浮卡删除后
    // `canvas-always` 消费点归零——规则与模板类必须一并退役，防死选择器空转。
    expect(sfc, '模板不得再有 canvas-always 落位').not.toContain('class="canvas-always')
    expect(
      extractRuleBlock(sfc, '.agent-panel-mobile-dock.is-canvas-view .agent-system-layer > .canvas-always'),
      '放行规则必须删除',
    ).toBe('')
    // 有效性断言：容器默认全隐规则仍在（证明扫的是活的样式主体）
    const container = extractRuleBlock(sfc, '.agent-panel-mobile-dock.is-canvas-view .agent-system-layer')
    expect(container).toContain('display: none')
  })

  it('画布视图：canvas-with-composer 白名单已随对话流外 ask 卡下线退役（死规则不残留）', () => {
    // 根治规格 2026-10-29：ask 题面收敛进时间线 question part（AgentTurnTimeline 内联），
    // 跟随 chat-wrap 可见性——`canvas-with-composer` 消费点归零，规则与模板类一并退役。
    expect(sfc, '模板不得再有 canvas-with-composer 落位').not.toContain(
      'class="mx-0.5 mb-2 canvas-with-composer"',
    )
    expect(
      extractRuleBlock(
        sfc,
        '.agent-panel-mobile-dock.is-canvas-view:not(.is-canvas-imm):not(.has-studio-dock) .agent-system-layer > .canvas-with-composer',
      ),
      '放行规则必须删除',
    ).toBe('')
    // 有效性断言：容器默认全隐规则仍在（证明扫的是活的样式主体）
    const container = extractRuleBlock(sfc, '.agent-panel-mobile-dock.is-canvas-view .agent-system-layer')
    expect(container).toContain('display: none')
  })

  it('画布视图：旧逐卡登记模式不得回归（deny-list 只许 header/chat-wrap/composer）', () => {
    // 防退回加法枚举：状态行/ask 卡/取消回执不得再有独立选择器，一律走容器默认全隐。
    expect(sfc).not.toContain('.agent-panel-mobile-dock.is-canvas-view .agent-turn-status')
    expect(sfc).not.toContain('.agent-panel-mobile-dock.is-canvas-view .agent-ask-layer')
    expect(sfc).not.toContain('.agent-panel-mobile-dock.is-canvas-view .agent-cancelled-layer')
  })

  it('系统层容器位置不变量：容器内卡片必须都在容器内', () => {
    // 新卡片若被加到容器外，画布视图会露头（旧 bug 形态）。容器开标签必须先于全部已知卡片。
    // 根治规格 2026-10-28/29：浮卡与对话流外 ask 卡均下线（决策点收敛进时间线内联卡，
    // 跟随 chat-wrap 可见性）。2026-10-31：状态行退役，容器内 = 移动端钉显 live 块
    // （时间线内联确认卡，进层即继承画布视图默认隐藏）/ 取消回执。
    const open = sfc.indexOf('<div class="agent-system-layer">')
    expect(open).toBeGreaterThan(0)
    expect(open).toBeLessThan(sfc.indexOf('<template v-if="isMobileLayout">'))
    expect(open).toBeLessThan(sfc.indexOf('data-testid="run-cancelled-callout"'))
  })
})
