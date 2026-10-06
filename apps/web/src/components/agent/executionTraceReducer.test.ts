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
import { presentToolStep } from '@/components/agent/toolPresentation'

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

describe('applyToolCall isError（P0 工具失败标红）', () => {
  it('isError 结果将工具步标为 failed，detail 取错误信息', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'run_image', undefined, { toolCallId: 't1' })
    applyToolCall(trace, 'run_image', { message: '生成超时' }, { toolCallId: 't1', isError: true })
    const step = trace.steps.find((s) => s.meta?.toolCallId === 't1')
    expect(step?.status).toBe('failed')
    expect(step?.detail).toContain('生成超时')
  })

  it('正常结果仍为 done（不回归）', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'run_image', undefined, { toolCallId: 't2' })
    applyToolCall(trace, 'run_image', { ok: 1 }, { toolCallId: 't2' })
    const step = trace.steps.find((s) => s.meta?.toolCallId === 't2')
    expect(step?.status).toBe('done')
  })

  it('replay 旧 metadata（无 isError 字段）不崩且为 done', () => {
    const trace = replayExecutionTraceEvents([
      { type: 'tool_call', data: { name: 'get_canvas_summary' } },
      { type: 'tool_result', data: { name: 'get_canvas_summary', result: { status: 'ok' } } },
    ])
    const step = trace.steps.find((s) => s.kind === 'tool')
    expect(step?.status).toBe('done')
  })

  it('replay 携带 isError 的 tool_result 标为 failed', () => {
    const trace = replayExecutionTraceEvents([
      { type: 'tool_call', data: { name: 'run_image' } },
      { type: 'tool_result', data: { name: 'run_image', result: { message: 'boom' }, isError: true } },
    ])
    const step = trace.steps.find((s) => s.kind === 'tool')
    expect(step?.status).toBe('failed')
  })
})

describe('replay 透传 args/toolCallId（P2 修复：刷新后步骤标签不降级）', () => {
  it('R1: replay 后 tool 步带 args 摘要，人话化标签含节点名（此前降级成裸「创建节点」）', () => {
    const trace = replayExecutionTraceEvents([
      {
        type: 'tool_call',
        data: { name: 'upsert_media_node', toolCallId: 'c1', args: { title: '三国英雄照片' } },
      },
      {
        type: 'tool_result',
        data: { name: 'upsert_media_node', toolCallId: 'c1', result: { status: 'ok' } },
      },
    ])
    const step = trace.steps.find((s) => s.kind === 'tool')
    expect(step?.meta?.toolCallId).toBe('c1')
    expect(step?.meta?.args).toBe('三国英雄照片')
    expect(presentToolStep(step!).label).toBe('创建节点 · 三国英雄照片')
  })

  it('R2: 同名并发调用 replay 各自按 toolCallId 闭合（不靠 name 兜底错配）', () => {
    const trace = replayExecutionTraceEvents([
      {
        type: 'tool_call',
        data: { name: 'upsert_media_node', toolCallId: 'c1', args: { title: 'A' } },
      },
      {
        type: 'tool_call',
        data: { name: 'upsert_media_node', toolCallId: 'c2', args: { title: 'B' } },
      },
      {
        type: 'tool_result',
        data: { name: 'upsert_media_node', toolCallId: 'c2', result: { status: 'ok' } },
      },
      {
        type: 'tool_result',
        data: { name: 'upsert_media_node', toolCallId: 'c1', result: { status: 'ok' } },
      },
    ])
    const steps = trace.steps.filter((s) => s.kind === 'tool')
    expect(steps).toHaveLength(2)
    expect(steps.every((s) => s.status === 'done')).toBe(true)
    expect(steps.map((s) => s.meta?.args).sort()).toEqual(['A', 'B'])
  })

  it('R3: 旧 metadata 无 args/toolCallId 时不崩、name+running 兜底仍合并为一步', () => {
    const trace = replayExecutionTraceEvents([
      { type: 'tool_call', data: { name: 'get_canvas_summary' } },
      { type: 'tool_result', data: { name: 'get_canvas_summary', result: { status: 'ok' } } },
    ])
    expect(trace.steps.filter((s) => s.kind === 'tool')).toHaveLength(1)
    expect(trace.steps.find((s) => s.kind === 'tool')?.status).toBe('done')
  })
})

describe('replayExecutionTraceEvents · task_list replay', () => {
  // I-1 修复：replay switch 缺 task_list case → task 步标题退化为「批量生成任务」兜底
  it('从 task_list + task_update 重建 task 步并保留 title（不再退化兜底）', () => {
    const trace = replayExecutionTraceEvents([
      { type: 'task_list', data: { items: [{ id: 'plan-1', title: '起稿', status: 'running' }] } },
      { type: 'task_update', data: { id: 'plan-1', status: 'done' } },
    ])
    const step = trace.steps.find((s) => s.kind === 'task')
    expect(step?.label).toBe('生成「起稿」')
    expect(step?.status).toBe('done')
  })

  it('task_list 多项各自建步且 status 非空时落 running', () => {
    const trace = replayExecutionTraceEvents([
      { type: 'task_list', data: { items: [
        { id: 'plan-1', title: '起稿', status: 'running' },
        { id: 'plan-2', title: '配图', status: 'running' },
      ] } },
    ])
    const steps = trace.steps.filter((s) => s.kind === 'task')
    expect(steps).toHaveLength(2)
    expect(steps[0]?.label).toBe('生成「起稿」')
    expect(steps[1]?.label).toBe('生成「配图」')
  })
})
