/**
 * W1c-2（D1=A）：question part 终态渲染——已回答 / 已超时 / 已跳过 三态只读小结。
 * 刷新/重连后由服务端 `interruption` 摘要重建出终态 part（reconcileTimelineInterruption），
 * 本测试锁定「终态 part 不出可操作卡、只读小结文案正确」这一出口行为。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

type QuestionPart = Extract<TimelinePart, { kind: 'question' }>

function questionPart(status: QuestionPart['status']): TimelinePart {
  return {
    kind: 'question',
    id: 'question:call-1',
    callId: 'call-1',
    title: '需要你回答',
    status,
    questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A', value: 'A' }] }],
    startedAt: Date.now(),
  }
}

function mountCard(status: QuestionPart['status']) {
  return mount(AgentTurnTimeline, {
    props: { parts: [questionPart(status)], canvasNodes: [] },
  })
}

describe('AgentTurnTimeline — question 终态渲染（W1c-2）', () => {
  it('answered ⇒ 只读小结「已回答」', () => {
    const w = mountCard('answered')
    const el = w.find('[data-test="timeline-question-terminal"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('已回答')
  })

  it('expired（超时） ⇒ 只读小结「已超时」', () => {
    const w = mountCard('expired')
    const el = w.find('[data-test="timeline-question-terminal"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('已超时')
  })

  it('declined（取消/中止） ⇒ 只读小结「已跳过」', () => {
    const w = mountCard('declined')
    const el = w.find('[data-test="timeline-question-terminal"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('已跳过')
  })

  it('pending_answer ⇒ 不出终态小结（出可操作 AskUserCard）', () => {
    const w = mountCard('pending_answer')
    expect(w.find('[data-test="timeline-question-terminal"]').exists()).toBe(false)
  })
})
