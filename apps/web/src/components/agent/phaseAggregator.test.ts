import { describe, expect, it } from 'vitest'
import { derivePhase, phaseForToolName, PHASE_BADGE } from './phaseAggregator'
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

describe('phaseForToolName（阶段分类单源析出，2026-11-22）', () => {
  it('与 derivePhase 分类同源（同一份 WRITE_TOOLS）', () => {
    expect(phaseForToolName('get_canvas_summary')).toBeNull()
    expect(phaseForToolName('set_node_text')).toBe('creating')
    expect(phaseForToolName('upsert_media_node')).toBe('creating')
    expect(phaseForToolName('run_image')).toBe('creating')
    expect(phaseForToolName('cancel_generation')).toBe('wrapping')
    expect(phaseForToolName('brand_new_tool')).toBeNull()

    // 等价性：derivePhase 对同一 trace 的结果 = 逐工具 phaseForToolName 的单调推进
    // （read-only 序列 derivePhase 返回 'exploring'，不能用 reduce 初始 null 做等价断言）
    const t = createExecutionTrace()
    applyToolCall(t, 'get_canvas_summary', { ok: 1 })
    applyToolCall(t, 'run_image', { ok: 1 })
    applyToolCall(t, 'cancel_generation', { ok: 1 })
    expect(derivePhase(t.steps)).toBe('wrapping')
  })
})
