import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

/**
 * 2026-10-15 生产反馈：对话框里同时出现**三条**竖直滚动条。
 *
 * 机制（三层 `overflow-y:auto` 叠加，全部命中同一条 dock）：
 *   ① 消息列表 `.agent-chat-scroll`（正常滚动主体）
 *   ② dock 外层 `.agent-dock-scroll--scrollable`（`min(42vh,400px)`，#416 起对所有活跃展示态恒生效）
 *   ③ `AgentTurnTimeline(dense)` 根 `max-height: min(46vh,420px)` + thinking running `<p>` `max-h-40`
 * ③ 与 ② **嵌套**。②③ 都为「限高防撑爆」而设，但 ② 已成为覆盖全场景的主防线，
 * ③ 是前提被 #416 推翻后残留的冗余嵌套。
 *
 * 本测试锁「**dock 内不得再出现内层滚动**」这条结构不变量：
 * 限高职责唯一归属 dock 外层，组件只管内容不管滚动。
 * ⚠️ 只锁断言不算回归防护——下面第 3 条用变异实测验证这些断言**能证伪**。
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
 * ⚠️ 这几个断言涉及的组件注释里**正面记录了被删除的历史**（含 `max-h-40`、
 * `DENSE_MAX_HEIGHT`、`max-height` 等字面量），全文匹配会把注释当代码 ⇒ 假红。
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
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '') // ③ Vue 模板 HTML 注释（可跨行）
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')
    })
    .join('\n')
}

describe('三滚动条治理 — dock 内不得再有内层滚动容器', () => {
  it('AgentTurnTimeline：dense 根节点不再挂 max-height/overflow-y（限高职责归 dock 外层）', () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [runningThinking()], streaming: true, dense: true },
      attachTo: document.body,
    })
    // 有效性断言（防空集假绿）：组件确实渲染了
    expect(w.find('.agent-turn-timeline').exists()).toBe(true)
    const style = w.find('.agent-turn-timeline').attributes('style') ?? ''
    expect(style, `dense 根不应再带 max-height；实际 style=${style}`).not.toContain('max-height')
    expect(style, `dense 根不应再带 overflow-y；实际 style=${style}`).not.toMatch(/overflow/)
  })

  it('AgentTurnTimeline：thinking running 块不再挂 max-h-40 / overflow-y-auto', () => {
    // ⚠️ 只扫「代码」不扫注释：本文件注释里正面记录了这段历史（含 max-h-40 字面量），
    //   全文匹配会把注释当成代码 ⇒ 假红。剔除 // 与 /* * 开头（含 * 续行）的行。
    const src = stripComments(readFileSync(timelinePath, 'utf8'))
    expect(
      src,
      'thinking running 块不得再加 max-h-40 overflow-y-auto（与 dock 外层构成第三条滚动条）',
    ).not.toMatch(/max-h-40/)
    // 有效性断言（防空集假绿）：确认确实扫到了模板主体
    expect(src, '应扫到模板主体').toMatch(/class="mt-1 whitespace-pre-wrap/)
  })

  it('AgentExecutionTrace：dense 展开的步骤 <ul> 不再加内层 max-height/overflow', () => {
    const src = stripComments(readFileSync(tracePath, 'utf8'))
    expect(
      src,
      'dense 步骤 <ul> 不得再挂 max-height/overflow-y（主防线在 dock 外层，内层即嵌套滚动）',
    ).not.toMatch(/max-height/)
    // 有效性断言（防空集假绿）：确认扫到了 template 主体
    expect(src, '应扫到 template 主体').toMatch(/data-testid="operation-steps"/)
  })

  it('组件源码里已无残留的 DENSE_MAX_HEIGHT 常量（做减法，不留死代码）', () => {
    const src = stripComments(readFileSync(timelinePath, 'utf8'))
    expect(src, 'DENSE_MAX_HEIGHT 已无使用者，应完全删除').not.toMatch(/DENSE_MAX_HEIGHT/)
    expect(src, 'rootStyle 已无使用者，应完全删除').not.toMatch(/rootStyle/)
    // 有效性断言（防空集假绿）：确认确实扫到了 script 主体
    expect(src, '应扫到 script 主体').toMatch(/const rootClass = computed/)
  })

  it('dock 外层限高仍是唯一防线（减法不得误删主防线）', () => {
    const rail = readFileSync(railPath, 'utf8')
    expect(rail).toMatch(/\.agent-dock-scroll--scrollable[\s\S]{0,200}max-height/)
  })

  it('消息列表的 min-h-0 不再被 scoped CSS 覆盖（scoped 特异性曾使模板死类失效）', () => {
    // 同样剔注释：本文件该规则上方的注释正面记录了被删的 `min-height` / `flex: 1` 字面量
    const rail = stripComments(readFileSync(railPath, 'utf8'))
    const m = rail.match(/\.agent-chat-scroll \{([\s\S]*?)\}/)
    expect(m, '应仍能找到 .agent-chat-scroll 规则').toBeTruthy()
    const body = m![1]
    expect(
      body,
      '.agent-chat-scroll 不得再设 min-height（360px 硬下限会挤压 dock、加剧多滚动条）',
    ).not.toMatch(/min-height/)
    expect(
      body,
      '.agent-chat-scroll 不得再设 flex 简写（会覆盖模板 flex-1 使 min-h-0 失效）',
    ).not.toMatch(/flex:\s*1/)
    // 有效性断言：确认规则体非空且保留了布局必需项
    expect(body, '应保留 flex 列布局').toMatch(/flex-direction:\s*column/)
  })
})
