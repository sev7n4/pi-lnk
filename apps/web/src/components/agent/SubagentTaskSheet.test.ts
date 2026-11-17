import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SubagentTaskSheet from './SubagentTaskSheet.vue'
import type { TimelinePart } from './turnTimeline'

type SubagentPart = Extract<TimelinePart, { kind: 'subagent_task' }>

const base = (over: Partial<SubagentPart> = {}): SubagentPart => ({
  kind: 'subagent_task',
  id: 'subagent:call-abcd1234',
  toolCallId: 'tc-1',
  callId: 'call-abcd1234',
  displayName: '子代理 abcd1234',
  taskSummary: '调研 Tavily 免费计划配额：查官网定价页与…',
  task: '调研 Tavily 免费计划配额：查官网定价页与 FAQ\n【背景】已读过旧资料',
  status: 'completed',
  durationMs: 59000,
  turns: 4,
  report: 'Tavily 免费档 Researcher，1,000 credits/月。来源：https://tavily.com/#pricing',
  startedAt: Date.now(),
  ...over,
} as SubagentPart)

function mountSheet(part: SubagentPart) {
  return mount(SubagentTaskSheet, { props: { part }, attachTo: document.body })
}

describe('SubagentTaskSheet — 子代理详情面板（spec 2026-11-17）', () => {
  it('C1：展示完整 task（含换行/背景）与报告全文', () => {
    const w = mountSheet(base())
    expect(w.get('[data-testid="subagent-task-sheet"]').attributes('role')).toBe('dialog')
    const fullTask = w.get('.task-full').text()
    expect(fullTask).toContain('查官网定价页与 FAQ')
    expect(fullTask).toContain('【背景】已读过旧资料')
    expect(w.get('[data-testid="subagent-report"]').text()).toContain('1,000 credits/月')
  })

  it('C1：状态/耗时/轮数展示', () => {
    const w = mountSheet(base())
    const row = w.get('[data-testid="subagent-status-row"]').text()
    expect(row).toContain('已完成')
    expect(row).toContain('59s')
    expect(row).toContain('4 轮')
  })

  it('C3：stream_interrupted + partial 显示「结果中断」+ 不完整提示', () => {
    const w = mountSheet(base({ status: 'stream_interrupted', partial: true, report: '半截' }))
    expect(w.get('[data-testid="subagent-status-row"]').text()).toContain('结果中断')
    expect(w.find('[data-testid="subagent-incomplete-hint"]').exists()).toBe(true)
  })

  it('C4：degraded 无报告显示「结果已并入回复」兜底', () => {
    const w = mountSheet(base({ status: 'interrupted', degraded: true, report: undefined, durationMs: undefined, turns: undefined }))
    expect(w.get('[data-testid="subagent-degraded"]').text()).toBe('结果已并入回复')
  })

  it('C4：running 无报告显示「仍在运行」，非 degraded', () => {
    const w = mountSheet(base({ status: 'running', report: undefined, durationMs: undefined, turns: undefined }))
    expect(w.find('[data-testid="subagent-still-running"]').exists()).toBe(true)
  })

  it('关闭按钮 emit close', async () => {
    const w = mountSheet(base())
    await w.get('[data-testid="subagent-sheet-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
