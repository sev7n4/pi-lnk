import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 2026-10-14 生产反馈（阻塞等待确认时历史对话无法上下滑动）的**终局守卫**。
 *
 * 事故脉络：
 *   - 2026-10-09 首修：给 AgentExecutionTrace(dense) 步骤 ul 加 max-height——
 *     只修了「通电的那根线」，AgentTurnTimeline(dense) 无上限 ⇒ 2026-10-14 复发。
 *   - #416：把限高门控从内容枚举（只认已取消态）扩成结构不变量（hasDockPresentation）。
 *   - 治理 1/2（#421）：删掉组件内层与 dock 外层的冗余嵌套滚动。
 *   - 治理 2/2（本 PR）：**结构终局**——live 态对话内容（live 时间线 / proposeWait /
 *     ask 卡 / 取消提示）移回 `.agent-chat-scroll` 主滚动流，dock 只留 composer，
 *     第二滚动上下文（.agent-dock-scroll 系列）与 hasDockPresentation 门控一并删除。
 *     「dock 内容撑高 shrink-0 压扁 flex-1 滚动区」这一事故形态在结构上不再可能：
 *     所有对话内容都在 flex-1 的滚动区里，再长也只是让滚动区变长。
 *
 * 本测试锁终局结构不变量（而非任何门控/魔数）：
 *   ① dock 不再承载对话内容（live 块的模板位置在输入区之前）
 *   ② hasDockPresentation 门控已删（防止未来有人往 dock 加回内容又给门控续命）
 *   ③ dense 卡片限高守卫在两个时间线组件自身（唯一允许的内嵌滚动）
 */

const sideRail = readFileSync(resolve(__dirname, 'AgentSideRail.vue'), 'utf8')
const timeline = readFileSync(resolve(__dirname, 'AgentTurnTimeline.vue'), 'utf8')
const trace = readFileSync(resolve(__dirname, 'AgentExecutionTrace.vue'), 'utf8')

/** 剔除三种注释形态，防「注释里正面记录被删历史」造成的假红。 */
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

describe('AgentSideRail — 滚动上下文唯一（治理 2/2 终局结构）', () => {
  it('① live 态对话内容全部在主滚动流内：提示条模板位置在输入区之前', () => {
    const rail = sideRail // ① 已是 readFileSync 的文件内容，勿再当路径读（CI 曾因此假红）
    const iScroll = rail.indexOf('agent-chat-scroll')
    const iWait = rail.indexOf('data-testid="propose-wait-hint"')
    const iAsk = rail.indexOf('<AskUserCard')
    const iInput = rail.indexOf('class="agent-input-area')
    expect(iScroll).toBeGreaterThan(-1)
    expect(iWait).toBeGreaterThan(-1)
    expect(iAsk).toBeGreaterThan(-1)
    expect(iInput).toBeGreaterThan(-1)
    expect(
      iScroll < iWait && iWait < iInput && iAsk < iInput,
      `模板顺序必须 主滚动容器(${iScroll}) < 提示条(${iWait})/ask卡(${iAsk}) < 输入区(${iInput})——对话内容不得落回 dock`,
    ).toBe(true)
  })

  it('② 第二滚动上下文与门控已删除（防止往 dock 加回内容又给门控续命）', () => {
    const rail = stripComments(sideRail)
    expect(rail, '.agent-dock-scroll 系列必须完全删除').not.toMatch(/agent-dock-scroll/)
    expect(rail, 'hasDockPresentation 已无消费点，必须删除').not.toMatch(/hasDockPresentation/)
    // 有效性断言（防空集假绿）
    expect(rail, '应扫到模板主体').toMatch(/data-testid="propose-wait-hint"/)
    expect(rail, '应扫到样式主体').toMatch(/\.agent-chat-scroll \{/)
  })

  it('③ dense 卡片限高守卫在两个时间线组件自身（唯一允许的内嵌滚动）', () => {
    const tl = stripComments(timeline).match(/\.agent-turn-timeline--dense \{([\s\S]*?)\}/)
    expect(tl, 'AgentTurnTimeline 必须自带 dense 限高').toBeTruthy()
    expect(tl![1]).toMatch(/max-height/)
    expect(tl![1]).toMatch(/overflow-y:\s*auto/)

    const tr = stripComments(trace).match(/\.agent-trace--dense \{([\s\S]*?)\}/)
    expect(tr, 'AgentExecutionTrace 必须自带 dense 限高').toBeTruthy()
    expect(tr![1]).toMatch(/max-height/)
    expect(tr![1]).toMatch(/overflow-y:\s*auto/)
  })
})
