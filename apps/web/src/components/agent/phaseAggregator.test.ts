import { describe, expect, it } from 'vitest'
import { derivePhase, PHASE_BADGE } from './phaseAggregator'
import { applyToolCall, createExecutionTrace, type ExecutionStep } from './executionTraceReducer'

describe('derivePhase（P1#4 阶段徽章）', () => {
  it('无工具步返回 null', () => {
    expect(derivePhase(createExecutionTrace().steps)).toBeNull()
  })

  it('read 工具 → exploring，写工具 → creating，cancel 后 → wrapping', () => {
    const t = createExecutionTrace()
    applyToolCall(t, 'get_canvas_summary', { ok: 1 })
    expect(derivePhase(t.steps)).toBe('exploring')
    applyToolCall(t, 'upsert_media_node', undefined, { toolCallId: 'w1' })
    applyToolCall(t, 'upsert_media_node', { ok: 1 }, { toolCallId: 'w1' })
    expect(derivePhase(t.steps)).toBe('creating')
    applyToolCall(t, 'cancel_generation', { ok: 1 })
    expect(derivePhase(t.steps)).toBe('wrapping')
  })

  it('run_ 前缀生成工具归 creating', () => {
    const t = createExecutionTrace()
    applyToolCall(t, 'run_image', { ok: 1 })
    expect(derivePhase(t.steps)).toBe('creating')
  })

  it('未知工具不抛错、不推进阶段', () => {
    const t = createExecutionTrace()
    applyToolCall(t, 'brand_new_tool', { ok: 1 })
    expect(derivePhase(t.steps)).toBe('exploring')
  })

  it('非 tool 步骤被忽略', () => {
    const steps: ExecutionStep[] = [
      { id: 'x', kind: 'phase', label: '门控', status: 'waiting_user' },
      { id: 'y', kind: 'thinking', label: '思考中…', status: 'done' },
    ]
    expect(derivePhase(steps)).toBeNull()
  })

  it('PHASE_BADGE 三态齐全', () => {
    expect(PHASE_BADGE.exploring.label).toBe('探索中')
    expect(PHASE_BADGE.creating.label).toBe('创作中')
    expect(PHASE_BADGE.wrapping.label).toBe('收尾中')
  })
})
