import { describe, expect, it } from 'vitest'
import {
  applyCanvasAction,
  applyNodeStatus,
  applyPhaseHint,
  applyStep,
  applyTextReplaceStage,
  applyToolCall,
  applyTurnUsage,
  createExecutionTrace,
  finalizeExecutionTrace,
  replayExecutionTraceEvents,
  turnSummaryLine,
} from '@/components/agent/executionTraceReducer'
import { labelFromTextReplace } from '@/components/agent/executionStepLabels'

describe('executionStepLabels', () => {
  it('maps sidebar copy stages', () => {
    expect(labelFromTextReplace('好的，我来生成图片「模特」')).toBe('理解需求')
    expect(labelFromTextReplace('已在画布创建节点，正在生成…')).toBe('创建画布节点')
    expect(labelFromTextReplace('「模特」生成完成，请在画布查看节点。')).toBe('生成完成')
  })
})

describe('executionTraceReducer', () => {
  it('records text_replace stages without duplicate labels', () => {
    const trace = createExecutionTrace()
    applyTextReplaceStage(trace, '好的，我来生成图片「模特」')
    applyTextReplaceStage(trace, '已在画布创建节点，正在生成…')
    applyTextReplaceStage(trace, '「模特」生成完成，请在画布查看节点。')
    expect(trace.steps.map((s) => s.label)).toEqual(['理解需求', '创建画布节点', '生成完成'])
  })

  it('tracks node_status running then done', () => {
    const trace = createExecutionTrace()
    applyNodeStatus(trace, { nodeId: 'n1', status: 'generating' })
    applyNodeStatus(trace, { nodeId: 'n1', status: 'completed' })
    expect(trace.steps).toHaveLength(1)
    expect(trace.steps[0]?.label).toBe('节点出图完成')
    expect(trace.steps[0]?.status).toBe('done')
  })

  it('adds canvas_action step', () => {
    const trace = createExecutionTrace()
    applyCanvasAction(trace, {
      type: 'add_node',
      payload: { id: 'n1', nodeType: 'image', data: { title: '模特图' } },
    })
    expect(trace.steps[0]?.label).toContain('添加图片节点')
    expect(trace.steps[0]?.meta?.nodeId).toBe('n1')
  })

  it('finalizes totalMs', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'run_image_generation')
    finalizeExecutionTrace(trace)
    expect(trace.totalMs).toBeGreaterThanOrEqual(0)
    expect(trace.steps[0]?.status).toBe('done')
  })

  it('applies step events and dedupes text_stage', () => {
    const trace = createExecutionTrace()
    applyTextReplaceStage(trace, '好的，我来生成图片「模特」')
    applyStep(trace, {
      id: 'node:parse_atomic_intent',
      label: '理解需求',
      status: 'done',
      ms: 50,
    })
    expect(trace.steps.some((s) => s.kind === 'text_stage')).toBe(false)
    expect(trace.steps.some((s) => s.id === 'node:parse_atomic_intent')).toBe(true)
  })

  it('applies phase hint as waiting_user', () => {
    const trace = createExecutionTrace()
    applyPhaseHint(trace, { phase: 'await_confirm', label: '等待你确认方案' })
    expect(trace.steps[0]?.status).toBe('waiting_user')
  })

  it('replays persisted execution events', () => {
    const trace = replayExecutionTraceEvents([
      { type: 'text_replace', data: { text: '好的，我来生成图片「模特」' } },
      { type: 'step', data: { id: 'n1', label: '理解需求', status: 'done', ms: 12 } },
    ])
    expect(trace.steps.some((s) => s.label === '理解需求')).toBe(true)
    expect(trace.totalMs).toBeGreaterThanOrEqual(0)
  })
})

describe('applyToolCall toolCallId 合并（可观测性专项）', () => {
  it('A1: 同名工具交错调用按 toolCallId 各自闭合', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'upsert_media_node', undefined, { toolCallId: 'c1' })
    applyToolCall(trace, 'upsert_media_node', undefined, { toolCallId: 'c2' })
    applyToolCall(trace, 'upsert_media_node', { message: 'ok' }, { toolCallId: 'c1' })
    applyToolCall(trace, 'upsert_media_node', { message: 'ok' }, { toolCallId: 'c2' })
    const toolSteps = trace.steps.filter((s) => s.kind === 'tool')
    expect(toolSteps).toHaveLength(2)
    expect(toolSteps.every((s) => s.status === 'done')).toBe(true)
    expect(toolSteps.map((s) => s.meta?.toolCallId).sort()).toEqual(['c1', 'c2'])
  })

  it('A2: tool_result 先到（乱序）降级为新建完成态步骤，不崩', () => {
    const trace = createExecutionTrace()
    expect(() =>
      applyToolCall(trace, 'load_skill', { message: 'ok' }, { toolCallId: 'c9' }),
    ).not.toThrow()
    expect(trace.steps.filter((s) => s.kind === 'tool')).toHaveLength(1)
  })

  it('A3: 无 toolCallId（老链路）保持 name+running 匹配语义', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'explore_canvas')
    applyToolCall(trace, 'explore_canvas', { status: 'ok' })
    const toolSteps = trace.steps.filter((s) => s.kind === 'tool')
    expect(toolSteps).toHaveLength(1)
    expect(toolSteps[0].status).toBe('done')
  })

  it('A6: 已闭合的 toolCallId 重复收到 result（重放）不产生新步骤', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'load_skill', undefined, { toolCallId: 'c1' })
    applyToolCall(trace, 'load_skill', { message: 'a' }, { toolCallId: 'c1' })
    applyToolCall(trace, 'load_skill', { message: 'a' }, { toolCallId: 'c1' })
    expect(trace.steps.filter((s) => s.kind === 'tool')).toHaveLength(1)
  })
})

describe('applyTurnUsage + turnSummaryLine（P1 摘要行）', () => {
  it('T6-1: usage 覆盖幂等（replay 不叠加）', () => {
    const trace = createExecutionTrace()
    applyTurnUsage(trace, { inputTokens: 100, outputTokens: 20 })
    applyTurnUsage(trace, { inputTokens: 100, outputTokens: 20 })
    expect(trace.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
  })

  it('T6-2: 摘要行组装节点数/张数/耗时/tokens；无 usage 省略 tokens 段', () => {
    const trace = createExecutionTrace()
    trace.totalMs = 16000
    applyCanvasAction(trace, { type: 'add_node', payload: { nodeType: 'image', data: { title: '耳机' } } })
    applyCanvasAction(trace, { type: 'add_node', payload: { nodeType: 'image', data: { title: '音箱' } } })
    applyToolCall(trace, 'propose_generation', { status: 'pending_confirm' }, { args: '3 个节点' })
    applyTurnUsage(trace, { inputTokens: 3000, outputTokens: 400 })
    expect(turnSummaryLine(trace)).toBe('已创建 2 个节点 · 提议生成 3 张 · 用时 16s · 消耗 3.4k tokens')
  })

  it('T6-2b: 无 usage 省略 tokens 段；无画布/提议步骤省略对应段', () => {
    const trace = createExecutionTrace()
    trace.totalMs = 5000
    expect(turnSummaryLine(trace)).toBe('用时 5s')
  })

  it('T6-3: replay 后摘要行完整（turn_usage 事件回放还原 usage）', () => {
    const source = createExecutionTrace()
    applyToolCall(source, 'propose_generation', { status: 'pending_confirm' }, { args: '1 个节点' })
    applyTurnUsage(source, { inputTokens: 500, outputTokens: 100 })
    const replayed = replayExecutionTraceEvents([
      { type: 'tool_call', data: { name: 'propose_generation' } },
      { type: 'tool_result', data: { name: 'propose_generation', result: { status: 'pending_confirm' } } },
      { type: 'turn_usage', data: { inputTokens: 500, outputTokens: 100 } },
    ])
    expect(replayed.usage).toEqual({ inputTokens: 500, outputTokens: 100 })
    expect(turnSummaryLine(replayed)).toContain('消耗 600 tokens')
    expect(turnSummaryLine(source)).toContain('提议生成 1 张')
  })
})
