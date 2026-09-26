import { describe, expect, it } from 'vitest'
import { presentToolStep, timelineHeadline, collapsedDefault } from '@/components/agent/toolPresentation'
import { createExecutionTrace, applyToolCall } from '@/components/agent/executionTraceReducer'
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'

const step = (partial: Partial<ExecutionStep> & { meta?: ExecutionStep['meta'] }): ExecutionStep => ({
  id: 's1',
  kind: 'tool',
  label: '',
  status: 'done',
  startedAt: 0,
  ...partial,
}) as ExecutionStep

describe('toolPresentation（P1 注册表）', () => {
  it('注册表命中：读工具人话化', () => {
    expect(presentToolStep(step({ label: '调用 get_canvas_summary', status: 'done', meta: { toolName: 'get_canvas_summary', args: '3 个节点' } })))
      .toEqual({ icon: '🔍', label: '感知画布 · 3 个节点' })
    expect(presentToolStep(step({ label: '', status: 'running', meta: { toolName: 'propose_generation', args: '2 个节点' } })))
      .toEqual({ icon: '🖼️', label: '提议生成 · 2 个节点' })
  })
  it('run_ 前缀与未知工具兜底', () => {
    expect(presentToolStep(step({ status: 'done', meta: { toolName: 'run_image_generation' } })).icon).toBe('🎨')
    expect(presentToolStep(step({ status: 'done', meta: { toolName: 'mystery_tool' } })))
      .toEqual({ icon: '⚙', label: '调用 mystery_tool' })
  })
  it('meta.args 缺失时从 label 后缀解析（reducer 只把 args 写进 label）', () => {
    expect(presentToolStep(step({ label: '调用 get_canvas_summary · 3 个节点', meta: { toolName: 'get_canvas_summary' } })))
      .toEqual({ icon: '🔍', label: '感知画布 · 3 个节点' })
  })
  it('timelineHeadline：N 步 · 最新一步人话', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'get_canvas_summary', { status: 'ok' }, { args: '3 个节点' })
    applyToolCall(trace, 'propose_generation', { status: 'pending_confirm' }, { args: '3 个节点' })
    expect(timelineHeadline(trace)).toBe('2 步 · 最新：🖼️ 提议生成 · 3 个节点')
  })
  it('collapsedDefault：v1 固定默认折叠', () => {
    expect(collapsedDefault).toBe(true)
  })
})
