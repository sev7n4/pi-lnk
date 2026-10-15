import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import AgentExecutionTrace from './AgentExecutionTrace.vue'
import type { ExecutionTraceState } from './executionTraceReducer'

/**
 * 钉底活体 trace 展开后「历史列表滚动被锁死」的**结构性**回归守卫。
 *
 * 原始事故（2026-10-09 → 2026-10-14 复发）：展开的步骤 `<ul>` 无上限，长 thinking detail
 * 无限撑高 dock（shrink-0）⇒ `chat-wrap`(flex-1 min-h-0) 压到 0 高 ⇒ 历史既看不见也滑不动。
 *
 * 治理脉络：
 *   1/2（#421）：防线从组件内层移到 dock 外层（当时 dock 是第二滚动上下文）。
 *   2/2（本 PR）：**dock 滚动上下文整体删除**——live 态对话内容移回主滚动流，
 *   限高收回到 dense 卡片根（`.agent-trace--dense`，唯一允许的内嵌滚动）。
 *   「历史滑不动」在流内结构下不复存在：内容全在 flex-1 滚动区里，
 *   再长也只是让滚动区变长，不会挤压其他区域。
 *
 * 本测试因此锁三条 2/2 不变量：
 *   - dock 外层滚动容器必须已删除（防第二滚动上下文复发）；
 *   - dense 卡片根限高必须存在（内容超长时的唯一防线）；
 *   - 步骤 `<ul>` 不再挂内层滚动（卡片内再嵌套即复发三滚动条）。
 */

const sideRail = readFileSync(resolve(__dirname, 'AgentSideRail.vue'), 'utf8')
const traceSrc = readFileSync(resolve(__dirname, 'AgentExecutionTrace.vue'), 'utf8')

/** 剔除三种注释形态（TS 单行 / 块注释 / Vue 模板 HTML 注释），防「注释里记录被删历史」假红。 */
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

function traceWithLongThinking(): ExecutionTraceState {
  const longDetail = Array.from({ length: 40 }, (_, i) => `思考第 ${i + 1} 行：这是一段很长的模型思考内容，模拟流式 thinking 持续输出 1 分多钟的体量。`).join('\n')
  return {
    steps: [
      { id: 'thinking:parse', kind: 'thinking', label: '思考中…', status: 'done', ms: 76000, detail: longDetail },
      { id: 'node:create', kind: 'canvas', label: '创建提示词节点', status: 'done', ms: 120, meta: { nodeId: 'n1' } },
      { id: 'text:stream', kind: 'text_stage', label: '流式输出节点', status: 'running' },
    ],
    collapsed: false,
    turnStartedAt: Date.now(),
  }
}

describe('AgentExecutionTrace — 滚动上下文唯一（2/2），dense 限高收回卡片根', () => {
  it('dock 外层滚动容器已删除（2/2：live 内容移回主滚动流，防第二滚动上下文复发）', () => {
    const rail = stripComments(sideRail)
    expect(rail, '.agent-dock-scroll 系列必须从模板与 CSS 中完全删除').not.toMatch(/agent-dock-scroll/)
    expect(
      rail,
      '主滚动容器 .agent-chat-scroll 必须仍在（唯一滚动上下文）',
    ).toMatch(/agent-chat-scroll/)
  })

  it('dense 卡片根限高成对存在（内容超长时的唯一防线，防 #416 同类「撑爆」复发）', () => {
    // 选择器侧：根节点 dense 时挂 --dense 类
    expect(
      traceSrc,
      'dense 根必须挂 agent-trace--dense 类',
    ).toMatch(/agent-trace--dense/)
    // 规则侧：组件自身 scoped style 有限高（放父级 scoped 换父即静默失效）
    const m = stripComments(traceSrc).match(/\.agent-trace--dense \{([\s\S]*?)\}/)
    expect(m, '限高规则必须在组件自身 style 块').toBeTruthy()
    expect(m![1], '规则体必须含 max-height').toMatch(/max-height/)
    expect(m![1], '规则体必须含 overflow-y:auto').toMatch(/overflow-y:\s*auto/)
  })

  it('dense 展开态：步骤 <ul> 不挂内层 max-height/overflow（卡片根已限高，再内滚即嵌套复发）', () => {
    const w = mount(AgentExecutionTrace, {
      props: { trace: traceWithLongThinking(), streaming: true, dense: true, collapsed: false },
    })
    const ul = w.find('[data-testid="operation-steps"]')
    expect(ul.exists()).toBe(true)
    // 有效性断言（防空集假绿）：ul 确实渲染了步骤
    expect(w.findAll('[data-testid="operation-step"]').length).toBeGreaterThan(0)
    const style = ul.attributes('style') ?? ''
    const cls = ul.attributes('class') ?? ''
    expect(style, `dense 步骤 <ul> 不应自带 max-height 内联样式；实际 style=${style}`).not.toContain('max-height')
    expect(cls, `dense 步骤 <ul> 不应挂 max-h 溢出类；实际 class=${cls}`).not.toMatch(/max-h-|overflow/)
  })

  it('非 dense（气泡内）展开态：同样不加 max-height（气泡跟随主滚动流，两形态口径一致）', () => {
    const w = mount(AgentExecutionTrace, {
      props: { trace: traceWithLongThinking(), streaming: false, collapsed: false },
    })
    const ul = w.find('[data-testid="operation-steps"]')
    expect(ul.exists()).toBe(true)
    // 有效性断言：确实展开了、且有步骤
    expect(w.findAll('[data-testid="operation-step"]').length).toBeGreaterThan(0)
    const style = ul.attributes('style') ?? ''
    const cls = ul.attributes('class') ?? ''
    expect(style, `气泡形态不该加 max-height（否则双层滚）；实际 style=${style}`).not.toContain('max-height')
    expect(cls, `气泡形态不该挂溢出类；实际 class=${cls}`).not.toMatch(/max-h-|overflow/)
  })

  it('collapsed 态：不渲染 operation-section（头行之外无展开内容）', () => {
    const w = mount(AgentExecutionTrace, {
      props: { trace: traceWithLongThinking(), streaming: true, dense: true, collapsed: true },
    })
    expect(w.find('[data-testid="operation-section"]').exists()).toBe(false)
    expect(w.find('[data-testid="operation-steps"]').exists()).toBe(false)
  })

  it('回归守卫：点 dense 头行 emit update:collapsed=true（#258 受控折叠不回退）', async () => {
    const w = mount(AgentExecutionTrace, {
      props: { trace: traceWithLongThinking(), streaming: true, dense: true, collapsed: false },
    })
    await w.find('.agent-trace-toggle').trigger('click')
    const ev = w.emitted('update:collapsed')
    expect(ev, '点折叠头应上抛 update:collapsed').toBeTruthy()
    expect(ev![0][0]).toBe(true) // collapsed=true（取反 expanded）
  })
})
