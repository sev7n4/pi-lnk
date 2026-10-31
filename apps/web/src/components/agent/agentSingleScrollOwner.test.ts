import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

/**
 * 2026-10-15 三滚动条治理全程守卫。
 *
 * 1/2（#421）：删掉 dense 组件内层与 dock 外层的冗余嵌套滚动。
 * 2/2（本 PR）：live 态对话内容（时间线 / 提示卡 / ask 卡 / 取消提示）移回
 * `.agent-chat-scroll` 主滚动流，dock 只留 composer——用户口径
 * 「composer 上方的对话内容是一整套页面，只有思考消息流自带滚动条」。
 *
 * 本文件锁 2/2 之后的结构不变量：
 *   ① dock 不再存在第二个滚动上下文（.agent-dock-scroll 系列全删除）
 *   ② dense 时间线卡片自带限高滚动（唯一允许的内嵌滚动，选择器与规则成对存在）
 *   ③ thinking running 块不嵌第三层（卡片内再有内滚就是复发三滚动条）
 *   ④ 主滚动容器自身不再被 scoped 规则覆盖（min-h-0 必须真实生效）
 * ⚠️ 只锁断言不算回归防护——末条用变异实测验证断言能证伪。
 */

const railPath = resolve(__dirname, 'AgentSideRail.vue')
const timelinePath = resolve(__dirname, 'AgentTurnTimeline.vue')
const tracePath = resolve(__dirname, 'AgentExecutionTrace.vue')

function runningThinking(): TimelinePart {
  return {
    kind: 'thinking',
    id: 'thinking-1',
    text: Array.from({ length: 60 }, (_, i) => `思考第 ${i + 1} 行`).join('\n'),
    status: 'running',
    startedAt: Date.now(),
  }
}

/**
 * 剔除注释行，只留真实代码。
 *
 * ⚠️ 这几个断言涉及的组件注释里**正面记录了被删除的历史**（含 dock-scroll、
 * max-height 等字面量），全文匹配会把注释当代码 ⇒ 假红。
 *
 * 三种注释形态都要剔：
 *   ① 双斜杠单行（TS/JS）
 *   ② 块注释（行首星号为续行）
 *   ③ Vue 模板里的 HTML 注释（可跨行，**最容易漏，曾因此 CI 假红一次**）
 *
 * ⛔ 本注释内**不得出现任何注释终止符字面量**：写了会让注释提前闭合，
 * 解析器把后续代码当注释内容，报错行号指向毫不相干的位置（TS1127 / Unterminated
 * template literal），极易误判成别的问题。
 */
export function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '') // ③ Vue 模板 HTML 注释（可跨行）
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')
    })
    .join('\n')
}

describe('三滚动条治理 2/2 — 滚动上下文唯一，dense 卡片自带限高', () => {
  it('① dock 第二滚动上下文已彻底删除（模板 class + CSS 规则 + hasDockPresentation 全无）', () => {
    const rail = stripComments(readFileSync(railPath, 'utf8'))
    expect(rail, '.agent-dock-scroll 容器类应从模板与 CSS 中完全删除').not.toMatch(/agent-dock-scroll/)
    expect(rail, 'hasDockPresentation 判定已无消费点，应删除').not.toMatch(/hasDockPresentation/)
    expect(
      rail,
      '主滚动容器 .agent-chat-scroll 必须仍在',
    ).toMatch(/agent-chat-scroll/)
    // 有效性断言（防空集假绿）：确认确实扫到了模板与样式主体
    // （2026-10-31 状态行退役，模板主体锚点换为系统层容器）
    expect(rail, '应扫到模板主体').toMatch(/class="agent-system-layer"/)
    expect(rail, '应扫到样式主体').toMatch(/\.agent-chat-scroll \{/)
  })

  it('② AgentTurnTimeline：dense 根挂 --dense 类，且限高规则在组件自身 scoped style 中成对存在', () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [runningThinking()], streaming: true, dense: true },
      attachTo: document.body,
    })
    // 有效性断言（防空集假绿）：组件确实渲染了
    expect(w.find('.agent-turn-timeline').exists()).toBe(true)
    const cls = w.find('.agent-turn-timeline').attributes('class') ?? ''
    expect(cls, `dense 根必须挂 --dense 类（限高选择器）；实际 class=${cls}`).toContain('agent-turn-timeline--dense')

    const src = stripComments(readFileSync(timelinePath, 'utf8'))
    const m = src.match(/\.agent-turn-timeline--dense \{([\s\S]*?)\}/)
    expect(m, '限高规则必须存在于组件自身 style 块（放父级 scoped 换父即静默失效）').toBeTruthy()
    const body = m![1]
    expect(body, '规则体必须含 max-height').toMatch(/max-height/)
    expect(body, '规则体必须含 overflow-y:auto').toMatch(/overflow-y:\s*auto/)
    expect(body, '规则体应含 overscroll-behavior（防滚动链穿透）').toMatch(/overscroll-behavior/)
  })

  it('③ thinking running 块不嵌第三层滚动（卡片内再内滚即复发三滚动条）', () => {
    const src = stripComments(readFileSync(timelinePath, 'utf8'))
    expect(
      src,
      'thinking running 块不得再加 max-h-40 overflow-y-auto（卡片根已限高，再内滚即第三层）',
    ).not.toMatch(/max-h-40/)
    // 有效性断言（防空集假绿）：确认确实扫到了模板主体
    expect(src, '应扫到模板主体').toMatch(/class="mt-1 whitespace-pre-wrap/)
  })

  it('③b AgentExecutionTrace：步骤 <ul> 无内层滚动，dense 限高在卡片根成对存在', () => {
    const src = stripComments(readFileSync(tracePath, 'utf8'))
    const m = src.match(/\.agent-trace--dense \{([\s\S]*?)\}/)
    expect(m, 'dense 限高规则必须在组件自身 style 块').toBeTruthy()
    expect(m![1], '规则体必须含 max-height').toMatch(/max-height/)
    expect(m![1], '规则体必须含 overflow-y:auto').toMatch(/overflow-y:\s*auto/)
    // 模板里的步骤 <ul> 不挂内联限高/溢出（1/2 的断言口径延续到 2/2 语境）
    expect(
      src,
      '步骤 <ul> 标签不得挂 max-height/overflow 内联类（限高只在卡片根）',
    ).not.toMatch(/space-y-0\.5[^"']*max-h/)
    // 有效性断言：确认扫到了 template 主体
    expect(src, '应扫到 template 主体').toMatch(/data-testid="operation-steps"/)
  })

  it('④ 组件源码里无残留死代码（DENSE_MAX_HEIGHT / rootStyle）', () => {
    const src = stripComments(readFileSync(timelinePath, 'utf8'))
    expect(src, 'DENSE_MAX_HEIGHT 应完全删除').not.toMatch(/DENSE_MAX_HEIGHT/)
    expect(src, 'rootStyle 应完全删除').not.toMatch(/rootStyle/)
    // 有效性断言（防空集假绿）：确认确实扫到了 script 主体
    expect(src, '应扫到 script 主体').toMatch(/const rootClass = computed/)
  })

  it('⑤ live 态对话内容在主滚动流内、composer 之后无对话内容（模板顺序断言）', () => {
    const rail = readFileSync(railPath, 'utf8')
    const iScroll = rail.indexOf('agent-chat-scroll')
    // 2026-10-31 状态行退役：系统层锚点换为容器自身（状态行删除后系统层仍在，
    // 承载移动端钉显 live 块与取消回执）
    const iWait = rail.indexOf('class="agent-system-layer"')
    const iInput = rail.indexOf('class="agent-input-area')
    expect(iScroll, '主滚动容器应存在').toBeGreaterThan(-1)
    expect(iWait, '系统层应存在').toBeGreaterThan(-1)
    expect(iInput, '输入区应存在').toBeGreaterThan(-1)
    expect(
      iScroll < iWait && iWait < iInput,
      `模板顺序必须是 主滚动容器(${iScroll}) < 系统层(${iWait}) < 输入区(${iInput})——系统层搬回消息流后不得再落回 dock`,
    ).toBe(true)
  })

  it('⑥ 消息列表的 min-h-0 不被 scoped CSS 覆盖（scoped 特异性曾使模板死类失效）', () => {
    const rail = stripComments(readFileSync(railPath, 'utf8'))
    const m = rail.match(/\.agent-chat-scroll \{([\s\S]*?)\}/)
    expect(m, '应仍能找到 .agent-chat-scroll 规则').toBeTruthy()
    const body = m![1]
    expect(
      body,
      '.agent-chat-scroll 不得再设 min-height（硬下限会加剧多滚动条与布局抖动）',
    ).not.toMatch(/min-height/)
    expect(
      body,
      '.agent-chat-scroll 不得再设 flex 简写（会覆盖模板 flex-1 使 min-h-0 失效）',
    ).not.toMatch(/flex:\s*1/)
    // 有效性断言：确认规则体非空且保留了布局必需项
    expect(body, '应保留 flex 列布局').toMatch(/flex-direction:\s*column/)
  })
})
