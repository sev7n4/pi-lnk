import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentExecutionTrace from './AgentExecutionTrace.vue'
import type { ExecutionTraceState } from './executionTraceReducer'

/**
 * 2026-10-09 线上反馈（画布 cmv0w0tgn003nne01cxg1e4bp）：
 * 流式过程中展开钉底活体 trace 的「操作明细」（含长 thinking detail）后：
 *   ① 收不起 ② 右侧历史消息列表滚动条被锁死。
 * 根因：展开的 `<ul>` 无 max-height/overflow，长 thinking detail 无限撑高 dock（shrink-0、
 * `--scrollable` 修饰只挂 hasDockPresentation=showCancelledCallout，正常回合恒 false）⇒
 * `chat-wrap`（flex-1 min-h-0）被挤到 0 高 ⇒ 历史列表不可见/不可滚 + 头行命中区被顶飞。
 * 修法：dense（钉底活体）展开态给步骤 `<ul>` 加 max-height + overflow-y:auto + overscroll-behavior:contain。
 * 非钉底（气泡内）形态**不加**——气泡 trace 本就在可滚的消息列表里，再加内层滚动会双层滚。
 */

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

describe('AgentExecutionTrace — 钉底活体展开锁死修复', () => {
  it('dense 展开态：步骤 <ul> 有 max-height + overflow-y:auto（撑不爆 dock、历史列表不被挤 0）', () => {
    const w = mount(AgentExecutionTrace, {
      props: { trace: traceWithLongThinking(), streaming: true, dense: true, collapsed: false },
    })
    const ul = w.find('[data-testid="operation-steps"]')
    expect(ul.exists()).toBe(true)
    const style = ul.attributes('style') ?? ''
    // 有效性断言（防空集假绿）：ul 确实渲染了步骤
    expect(w.findAll('[data-testid="operation-step"]').length).toBeGreaterThan(0)
    expect(style, `步骤 <ul> 应带 max-height（dense 钉底形态）；实际 style=${style}`).toContain('max-height')
    expect(style, `步骤 <ul> 应 overflow-y:auto（内部滚动，不靠外层 dock 撑开）；实际 style=${style}`).toMatch(/overflow-y:\s*auto/)
    expect(style, `步骤 <ul> 应 overscroll-behavior:contain（防链式滚动历史）；实际 style=${style}`).toContain('overscroll-behavior')
  })

  it('非 dense（气泡内）展开态：步骤 <ul> 不加 max-height（气泡本就在可滚消息列表里，避免双层滚）', () => {
    const w = mount(AgentExecutionTrace, {
      props: { trace: traceWithLongThinking(), streaming: false, collapsed: false },
    })
    const ul = w.find('[data-testid="operation-steps"]')
    expect(ul.exists()).toBe(true)
    const style = ul.attributes('style') ?? ''
    // 有效性断言：确实展开了、且有步骤
    expect(w.findAll('[data-testid="operation-step"]').length).toBeGreaterThan(0)
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
