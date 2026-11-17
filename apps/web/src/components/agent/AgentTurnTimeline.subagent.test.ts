import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTurnTimeline from './AgentTurnTimeline.vue'
import type { TimelinePart } from './turnTimeline'

type SubagentPart = Extract<TimelinePart, { kind: 'subagent_task' }>

const card = (over: Partial<SubagentPart> = {}): TimelinePart => ({
  kind: 'subagent_task',
  id: 'subagent:call-abcd1234',
  callId: 'call-abcd1234',
  displayName: '子代理 abcd1234',
  taskSummary: '调研 Tavily 免费计划配额',
  task: '调研 Tavily 免费计划配额',
  status: 'completed',
  durationMs: 59000,
  report: '报告全文',
  startedAt: Date.now(),
  ...over,
} as TimelinePart)

function mountTimeline(parts: TimelinePart[]) {
  return mount(AgentTurnTimeline, { props: { parts }, attachTo: document.body })
}

describe('AgentTurnTimeline — 子代理任务卡（spec 2026-11-17）', () => {
  it('C1：渲染 subagent_task 卡，显示短码名/耗时/状态符号', () => {
    const w = mountTimeline([card()])
    const el = w.get('[data-testid="subagent-task-card"]')
    expect(el.text()).toContain('子代理 abcd1234')
    expect(el.text()).toContain('59s')
    expect(el.text()).toContain('✓')
  })

  it('C1：点击任务卡 emit openSubagentTask 带出 part', async () => {
    const w = mountTimeline([card()])
    await w.get('[data-testid="subagent-task-card"]').trigger('click')
    const emitted = w.emitted('openSubagentTask')
    expect(emitted).toHaveLength(1)
    expect((emitted![0][0] as SubagentPart).displayName).toBe('子代理 abcd1234')
  })

  it('C4：degraded 卡显示「结果已并入回复」', () => {
    const w = mountTimeline([card({ status: 'interrupted', degraded: true, report: undefined, durationMs: undefined })])
    expect(w.get('[data-testid="subagent-task-card"]').text()).toContain('结果已并入回复')
  })

  it('C6：普通 tool part 不渲染 subagent 卡（负例）', () => {
    const w = mountTimeline([{
      kind: 'tool', id: 'tool:x', toolName: 'run_text_generation', status: 'done', args: '',
    } as TimelinePart])
    expect(w.find('[data-testid="subagent-task-card"]').exists()).toBe(false)
  })
})
