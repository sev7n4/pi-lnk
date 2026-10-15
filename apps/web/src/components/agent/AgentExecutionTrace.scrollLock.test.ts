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
 * ⚠️ 2026-10-15 治理：防线**从组件内层移到 dock 外层**。
 *   上一版修法给 `AgentExecutionTrace(dense)` 的 `<ul>` 加 max-height（当时 dock 外层
 *   `--scrollable` 只认已取消态，正常流式回合恒 false ⇒ 内层是唯一防线）。
 *   #416 已把 `hasDockPresentation` 扩成结构不变量（liveTimeline / proposeWait / ask 卡
 *   都计入），dock 外层对所有活跃展示态恒限高 ⇒ 内层限高成为**冗余嵌套**，
 *   与 AgentTurnTimeline(dense) 的旧限高一起在流式回合里叠出三条竖直滚动条。
 *
 * 本测试因此锁「**限高防线存在于 dock 外层**」+「组件内层不再有嵌套滚动」两条：
 *   - 前者防 #416 同类复发（历史滑不动）；
 *   - 后者防三滚动条复发（嵌套滚动）。
 * 上一轮的回归测试只锁「单个组件的 style 字符串」，新组件一诞生就绕过它（复发即证据），
 * 所以本文件同时静态读 AgentSideRail.vue 断言主防线仍在。
 */

const sideRail = readFileSync(resolve(__dirname, 'AgentSideRail.vue'), 'utf8')

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

describe('AgentExecutionTrace — 展开限高防线在 dock 外层，组件内层不再嵌套滚动', () => {
  it('主防线：dock 外层 .agent-dock-scroll--scrollable 限高仍在（防 #416 历史锁死复发）', () => {
    expect(sideRail, 'AgentSideRail 必须保留 dock 外层限高类').toContain('.agent-dock-scroll--scrollable')
    expect(
      sideRail,
      'dock 外层限高必须真的带 max-height（否则 dock 会被撑爆、历史滑不动）',
    ).toMatch(/agent-dock-scroll--scrollable[\s\S]{0,200}max-height/)
    expect(
      sideRail,
      '主防线门控必须把 liveTimeline 计入（阻塞期钉底内容无上限会撑爆滚动区）',
    ).toMatch(/const hasDockPresentation = computed\([\s\S]{0,400}?liveTimeline/)
  })

  it('dense 展开态：步骤 <ul> 不再加内层 max-height/overflow（dock 外层已限高，内层是冗余嵌套）', () => {
    const w = mount(AgentExecutionTrace, {
      props: { trace: traceWithLongThinking(), streaming: true, dense: true, collapsed: false },
    })
    const ul = w.find('[data-testid="operation-steps"]')
    expect(ul.exists()).toBe(true)
    // 有效性断言（防空集假绿）：ul 确实渲染了步骤
    expect(w.findAll('[data-testid="operation-step"]').length).toBeGreaterThan(0)
    const style = ul.attributes('style') ?? ''
    expect(style, `dense 步骤 <ul> 不应再自带 max-height（主防线在 dock 外层）；实际 style=${style}`).not.toContain('max-height')
    expect(style, `dense 步骤 <ul> 不应再自带 overflow-y（否则与 dock 外层构成嵌套滚动=三滚动条）；实际 style=${style}`).not.toMatch(/overflow-y/)
  })

  it('非 dense（气泡内）展开态：同样不加 max-height（气泡在可滚消息列表里，两形态口径一致）', () => {
    const w = mount(AgentExecutionTrace, {
      props: { trace: traceWithLongThinking(), streaming: false, collapsed: false },
    })
    const ul = w.find('[data-testid="operation-steps"]')
    expect(ul.exists()).toBe(true)
    // 有效性断言：确实展开了、且有步骤
    expect(w.findAll('[data-testid="operation-step"]').length).toBeGreaterThan(0)
    const style = ul.attributes('style') ?? ''
    expect(style, `气泡形态不该加 max-height（否则双层滚）；实际 style=${style}`).not.toContain('max-height')
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
