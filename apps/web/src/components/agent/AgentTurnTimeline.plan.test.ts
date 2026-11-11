import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

/**
 * P1-2（spec 2026-11-11-propose-plan-visibility-design.md D4）：plan part 渲染——
 * propose_plan 方案本体在对话流的持久存档（plan_proposed 事件派生，live + 重放同源）。
 * 与确认卡（question part 内联 plan，P0-2）分工：卡是决策面，本 part 是方案存档。
 * 断言落在 DOM 出口（标题/解释/步骤/有序列表），不碰源码字符串。
 */

type PlanPart = Extract<TimelinePart, { kind: 'plan' }>

function planPart(overrides: Partial<PlanPart> = {}): TimelinePart {
  return {
    kind: 'plan',
    id: 'plan:call-1',
    callId: 'call-1',
    summary: '三步制作 Codex 知识教学视频（脚本→封面→成片）',
    explanation: '先脚本确保内容准确，再封面吸引点击，最后成片交付',
    steps: [
      { content: '编写教学脚本大纲' },
      { content: '创建视频封面图', activeForm: '正在创建封面图' },
      { content: '生成教学视频正文' },
    ],
    status: 'proposed',
    startedAt: Date.now(),
    ...overrides,
  }
}

function mountCard(parts: TimelinePart[]) {
  return mount(AgentTurnTimeline, {
    props: { parts, canvasNodes: [] },
  })
}

describe('AgentTurnTimeline — plan part 渲染（P1-2 方案存档）', () => {
  it('渲染方案标题 + 解释 + 有序步骤（序号 1..n + activeForm）', () => {
    const w = mountCard([planPart()])
    const el = w.find('[data-test="timeline-plan"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('三步制作 Codex')
    expect(el.text()).toContain('先脚本确保内容准确')
    const steps = el.findAll('ol li')
    expect(steps).toHaveLength(3)
    expect(steps[0].text()).toContain('编写教学脚本大纲')
    expect(steps[1].text()).toContain('创建视频封面图')
    expect(steps[1].text()).toContain('正在创建封面图')
    // 有序列表序号 1..3
    expect(steps[0].text()).toContain('1')
    expect(steps[2].text()).toContain('3')
  })

  it('无 explanation ⇒ 不渲染解释段（键不出现纪律的 DOM 面）', () => {
    const w = mountCard([planPart({ explanation: undefined })])
    const el = w.find('[data-test="timeline-plan"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).not.toContain('先脚本')
  })

  it('非 plan part ⇒ 不出方案块（其他分支不受影响）', () => {
    const w = mountCard([planPart(), { kind: 'notice', id: 'notice:1', text: '执行出错', tone: 'error' } as TimelinePart])
    expect(w.findAll('[data-test="timeline-plan"]')).toHaveLength(1)
    expect(w.text()).toContain('执行出错')
  })
})
