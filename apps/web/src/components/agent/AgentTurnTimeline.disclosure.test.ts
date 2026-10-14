import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

/**
 * 2026-10-14 生产反馈：「思考」点开之后无法收拢。
 *
 * 根因：`<details :open="part.status === 'running'">` 把**展示默认值**当**受控值**用。
 * 原生 `<details>` 的展开态在 DOM 上，用户点击直接改 DOM（不经过 Vue）；
 * 但只要 part.status 仍为 running，Vue 下次 patch 就把 :open 重新写回 true ⇒ 强制弹回。
 * 组件内**没有任何用户意图 state** —— 对比 AgentExecutionTrace 2026-10-07 已改成真受控
 * （expanded ref + emit update:collapsed + 父级持真相）。新组件没继承该修复。
 *
 * 本测试锁「用户可感知的结果」：手动折叠后，任何后续 patch（含 status 变化、
 * 文本增长、parts 重建）都必须保持用户的折叠选择。
 */

function thinkingPart(status: 'running' | 'done', text = '正在推理：先看画布摘要，再决定节点顺序。'): TimelinePart {
  return { kind: 'thinking', id: 'thinking-1', text, status, startedAt: Date.now() }
}

describe('AgentTurnTimeline — 思考块折叠契约（用户意图优先于展示默认值）', () => {
  it('running 态点开后手动收起，后续 patch 不得强制弹回（#414 回归）', async () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [thinkingPart('running')], streaming: true, dense: true },
      attachTo: document.body,
    })
    const details = w.find('details').element as HTMLDetailsElement
    expect(details.open, 'running 期间默认展开（展示默认值）').toBe(true)

    // 用户手动收起
    w.find('summary').trigger('click')
    await w.vm.$nextTick()
    expect(details.open, '用户点击后应收起').toBe(false)

    // 模拟流式继续推进：thinking 文本增长 + 新 part 追加 ⇒ 触发 patch
    await w.setProps({
      parts: [
        thinkingPart('running', '正在推理：先看画布摘要，再决定节点顺序。再确认参考图是否已绑定。'),
        { kind: 'text', id: 'text-1', text: '我来帮你制作这套图标库。', status: 'streaming' },
      ],
    })
    expect(details.open, '流式推进后必须保持用户选择的收起态').toBe(false)
  })

  it('用户手动展开后，status 翻 done 也不得强制收起（用户意图优先）', async () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [thinkingPart('done', '推理完成：决定用三次生成。')], streaming: false, dense: true },
      attachTo: document.body,
    })
    const details = w.find('details').element as HTMLDetailsElement
    // done 默认收起（展示默认值）
    expect(details.open, 'done 态默认收起').toBe(false)

    w.find('summary').trigger('click')
    await w.vm.$nextTick()
    expect(details.open, '用户点开后应展开').toBe(true)

    // 关键：parts 数组整体被重建（replay / liveTimeline 刷新），模拟 patch 再次发生
    await w.setProps({
      parts: [{ kind: 'thinking', id: 'thinking-1', text: '推理完成：决定用三次生成。', status: 'done', startedAt: Date.now() } as TimelinePart],
    })
    expect(details.open, 'parts 重建后必须保持用户展开的意图').toBe(true)
  })

  it('无用户操作时，展示默认值仍生效：running 展开 / done 收起（不回归产品意图）', async () => {
    const running = mount(AgentTurnTimeline, {
      props: { parts: [thinkingPart('running')], streaming: true, dense: true },
      attachTo: document.body,
    })
    expect((running.find('details').element as HTMLDetailsElement).open).toBe(true)

    const done = mount(AgentTurnTimeline, {
      props: { parts: [thinkingPart('done')], streaming: false, dense: true },
      attachTo: document.body,
    })
    expect((done.find('details').element as HTMLDetailsElement).open).toBe(false)
  })

  it('running→done 状态翻转时，未被用户操作过的块应自动收起（对齐 #414 设计意图）', async () => {
    const w = mount(AgentTurnTimeline, {
      props: { parts: [thinkingPart('running')], streaming: true, dense: true },
      attachTo: document.body,
    })
    const details = w.find('details').element as HTMLDetailsElement
    expect(details.open).toBe(true)

    await w.setProps({ parts: [thinkingPart('done')], streaming: false })
    expect(details.open, '用户没动过 ⇒ 跟随默认值自动收起').toBe(false)
  })
})
