import { describe, expect, it } from 'vitest'
import {
  applyCanvasAction,
  applyNodeStatus,
  applyPhaseHint,
  applyStep,
  applyTextReplaceStage,
  applyThinking,
  applyToolCall,
  applyTurnSettled,
  applyTurnUsage,
  createExecutionTrace,
  finalizeExecutionTrace,
  hasFailedTraceStep,
  replayExecutionTraceEvents,
  turnSettledText,
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

describe('applyThinking 分段 + 时间序（P0 agent-turn-timeline-design §5）', () => {
  it('P0-1/2: 多段思考与工具交错，思考不再置顶（第二段思考索引 > 工具）', () => {
    const trace = createExecutionTrace()
    applyThinking(trace, { status: 'running' })
    applyThinking(trace, { status: 'done', summary: '先想一下' })
    applyToolCall(trace, 'explore_canvas')
    applyThinking(trace, { status: 'running' })
    applyThinking(trace, { status: 'done', summary: '再想想' })
    const thinkingSteps = trace.steps.filter((s) => s.kind === 'thinking')
    const toolIdx = trace.steps.findIndex((s) => s.kind === 'tool')
    const secondThinkingIdx = trace.steps.findIndex((s, i) => s.kind === 'thinking' && i > toolIdx)
    expect(thinkingSteps).toHaveLength(2)
    expect(secondThinkingIdx).toBeGreaterThan(toolIdx)
    expect(thinkingSteps[0]?.detail).toBe('先想一下')
    expect(thinkingSteps[1]?.detail).toBe('再想想')
  })

  it('P0-2: 工具先到时首步 kind 不为 thinking（unshift 不再把思考钉在队头）', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'explore_canvas')
    applyThinking(trace, { status: 'running' })
    applyThinking(trace, { status: 'done', summary: '思考' })
    expect(trace.steps[0]?.kind).toBe('tool')
    expect(trace.steps.find((s) => s.kind === 'thinking')?.status).toBe('done')
  })

  it('P0-5: replay 多段思考按序还原（thinking 事件已按序落库）', () => {
    const trace = replayExecutionTraceEvents([
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: 'A' } },
      { type: 'tool_call', data: { name: 'explore_canvas' } },
      { type: 'tool_result', data: { name: 'explore_canvas', result: { status: 'ok' } } },
      { type: 'thinking', data: { status: 'running' } },
      { type: 'thinking', data: { status: 'done', summary: 'B' } },
    ])
    const thinkingSteps = trace.steps.filter((s) => s.kind === 'thinking')
    expect(thinkingSteps).toHaveLength(2)
    expect(thinkingSteps[0]?.detail).toBe('A')
    expect(thinkingSteps[1]?.detail).toBe('B')
    const toolIdx = trace.steps.findIndex((s) => s.kind === 'tool')
    const secondThinkingIdx = trace.steps.findIndex((s, i) => s.kind === 'thinking' && i > toolIdx)
    expect(secondThinkingIdx).toBeGreaterThan(toolIdx)
  })

  it('P0-5: 缺 start 只发 done 的脏数据兜底为单段 done（不崩、不置顶）', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'explore_canvas')
    applyThinking(trace, { status: 'done', summary: '只有 done' })
    expect(trace.steps[0]?.kind).toBe('tool')
    expect(trace.steps.find((s) => s.kind === 'thinking')?.detail).toBe('只有 done')
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

  it('T6-4: usage 带 cost 时写入并幂等覆盖；无 cost 字段不出现（向后兼容）', () => {
    const trace = createExecutionTrace()
    applyTurnUsage(trace, { inputTokens: 664, outputTokens: 211, cost: 0.00016469 })
    applyTurnUsage(trace, { inputTokens: 664, outputTokens: 211, cost: 0.00016469 })
    expect(trace.usage).toEqual({ inputTokens: 664, outputTokens: 211, cost: 0.00016469 })

    const bare = createExecutionTrace()
    applyTurnUsage(bare, { inputTokens: 100, outputTokens: 20 })
    expect(bare.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
    expect('cost' in (bare.usage ?? {})).toBe(false)
  })

  it('T6-5: 摘要行带 cost 段（3 位有效数字防浮点尾巴）；无 cost 省略该段', () => {
    const trace = createExecutionTrace()
    applyTurnUsage(trace, { inputTokens: 664, outputTokens: 211, cost: 0.00016469 })
    const line = turnSummaryLine(trace)
    expect(line).toContain('费用 ≈0.000165')

    const bare = createExecutionTrace()
    applyTurnUsage(bare, { inputTokens: 100, outputTokens: 20 })
    expect(turnSummaryLine(bare)).not.toContain('费用')
  })

  it('T6-6: replay 透传 cost 字段', () => {
    const replayed = replayExecutionTraceEvents([
      { type: 'turn_usage', data: { inputTokens: 664, outputTokens: 211, cost: 0.00016469 } },
    ])
    expect(replayed.usage).toEqual({ inputTokens: 664, outputTokens: 211, cost: 0.00016469 })
  })

  it('P2 T5: usage 带 cache tokens → 透传写入；摘要合计 = input+cacheRead+cacheWrite+output（总量不缩水）', () => {
    const trace = createExecutionTrace()
    applyTurnUsage(trace, { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 30 })
    expect(trace.usage).toEqual({
      inputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      outputTokens: 30,
    })
    expect(turnSummaryLine(trace)).toContain('消耗 380 tokens')
  })

  it('P2 T5: replay 透传 cache 字段；旧形态 turn_usage（无 cache 字段）不炸、cache 键不出现', () => {
    const replayed = replayExecutionTraceEvents([
      { type: 'turn_usage', data: { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 30 } },
    ])
    expect(replayed.usage).toEqual({
      inputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      outputTokens: 30,
    })

    const legacy = replayExecutionTraceEvents([
      { type: 'turn_usage', data: { inputTokens: 100, outputTokens: 30 } },
    ])
    expect(legacy.usage).toEqual({ inputTokens: 100, outputTokens: 30 })
    expect(turnSummaryLine(legacy)).toContain('消耗 130 tokens')
  })
})

describe('applyTurnSettled + turnSummaryLine settled 段（P2 T7 / 终审 I-1）', () => {
  it('T7-1: 正常 settled（真实事件形状：tokens 千级 token 数 + breakdown 个位积分）→ 按 tokens 渲染', () => {
    const trace = createExecutionTrace()
    applyTurnUsage(trace, { inputTokens: 8200, outputTokens: 400, estimatedCredits: 8 })
    applyTurnSettled(trace, {
      holdId: 'h1',
      credits: 8,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 8200, cache: 300, out: 400 },
    })
    expect(turnSettledText(trace)).toBe(
      '已结算 -8 积分（输入 8.2k · 缓存 300 · 输出 400）',
    )
    expect(turnSummaryLine(trace)).toContain(
      '已结算 -8 积分（输入 8.2k · 缓存 300 · 输出 400）',
    )
    // I-1：formatTokens 语义归位——breakdown 是积分成分（个位），绝不再被当 token 渲染
    expect(turnSettledText(trace)).not.toBe('已结算 -8 积分（输入 2 · 缓存 0 · 输出 1）')
  })

  it('T7-1b: 旧形状事件（无 tokens 键，理论不存在——flag 未上线前无存量）→ 回退无 token 段', () => {
    const trace = createExecutionTrace()
    applyTurnSettled(trace, { holdId: 'h1b', credits: 8, breakdown: { in: 2, cache: 0, out: 1 } })
    expect(turnSettledText(trace)).toBe('已结算 -8 积分')
  })

  it('T7-2: degraded（无 breakdown）→ 「已结算 -N 积分（按成本估算）」', () => {
    const trace = createExecutionTrace()
    applyTurnUsage(trace, { inputTokens: 8000, outputTokens: 500 })
    applyTurnSettled(trace, { holdId: 'h2', credits: 5, ruleVersion: 'constants-fallback', degraded: true })
    expect(trace.settled).toEqual({
      holdId: 'h2',
      credits: 5,
      ruleVersion: 'constants-fallback',
      degraded: true,
    })
    expect(turnSettledText(trace)).toBe('已结算 -5 积分（按成本估算）')
  })

  it('T7-3: released（回合中断/失败预扣全退）→ 「预扣已退回」，不显示负数', () => {
    const trace = createExecutionTrace()
    applyTurnSettled(trace, { holdId: 'h3', released: true })
    expect(trace.settled).toEqual({ holdId: 'h3', released: true })
    expect(turnSettledText(trace)).toBe('预扣已退回')
    expect(turnSettledText(trace)).not.toContain('积分')
  })

  it('T7-4: 差额规则：|实际 − 预估| ≥ 2 → 追加「（预估 M）」；< 2 或无预估 → 不追加', () => {
    const diff = createExecutionTrace()
    applyTurnUsage(diff, { inputTokens: 1000, outputTokens: 200, estimatedCredits: 12 })
    applyTurnSettled(diff, {
      holdId: 'h4',
      credits: 8,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 1000, cache: 0, out: 200 },
    })
    expect(turnSettledText(diff)).toBe(
      '已结算 -8 积分（输入 1.0k · 缓存 0 · 输出 200）（预估 12）',
    )

    const close = createExecutionTrace()
    applyTurnUsage(close, { inputTokens: 1000, outputTokens: 200, estimatedCredits: 9 })
    applyTurnSettled(close, {
      holdId: 'h5',
      credits: 8,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 1000, cache: 0, out: 200 },
    })
    expect(turnSettledText(close)).not.toContain('预估')

    const noEstimate = createExecutionTrace()
    applyTurnUsage(noEstimate, { inputTokens: 1000, outputTokens: 200 })
    applyTurnSettled(noEstimate, {
      holdId: 'h6',
      credits: 8,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 1000, cache: 0, out: 200 },
    })
    expect(turnSettledText(noEstimate)).not.toContain('预估')
  })

  it('T7-5: 覆盖幂等（重复调用不叠加）+ 键不出现纪律（breakdown/tokens/degraded 缺省键不写入）', () => {
    const trace = createExecutionTrace()
    applyTurnSettled(trace, {
      holdId: 'h7',
      credits: 8,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 1000, cache: 0, out: 200 },
    })
    applyTurnSettled(trace, {
      holdId: 'h7',
      credits: 8,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 1000, cache: 0, out: 200 },
    })
    expect(trace.settled).toEqual({
      holdId: 'h7',
      credits: 8,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 1000, cache: 0, out: 200 },
    })

    const bare = createExecutionTrace()
    applyTurnSettled(bare, { holdId: 'h8', released: true })
    expect('credits' in (bare.settled ?? {})).toBe(false)
    expect('breakdown' in (bare.settled ?? {})).toBe(false)
    expect('tokens' in (bare.settled ?? {})).toBe(false)
    expect('degraded' in (bare.settled ?? {})).toBe(false)
  })

  it('T7-6: replay 透传 turn_settled；旧事件流（无 turn_settled）settled 键不出现、摘要无已结算段', () => {
    const replayed = replayExecutionTraceEvents([
      { type: 'turn_usage', data: { inputTokens: 8200, outputTokens: 400, estimatedCredits: 8 } },
      {
        type: 'turn_settled',
        data: {
          holdId: 'h9',
          credits: 8,
          breakdown: { in: 2, cache: 0, out: 1 },
          tokens: { in: 8200, cache: 0, out: 400 },
        },
      },
    ])
    expect(replayed.settled).toEqual({
      holdId: 'h9',
      credits: 8,
      breakdown: { in: 2, cache: 0, out: 1 },
      tokens: { in: 8200, cache: 0, out: 400 },
    })
    expect(turnSummaryLine(replayed)).toContain('已结算 -8 积分（输入 8.2k · 缓存 0 · 输出 400）')

    const legacy = replayExecutionTraceEvents([
      { type: 'turn_usage', data: { inputTokens: 500, outputTokens: 100 } },
    ])
    expect(legacy.settled).toBeUndefined()
    expect(turnSummaryLine(legacy)).not.toContain('已结算')
  })

  it('T7-7: released 态摘要段不产生负数积分文案', () => {
    const trace = replayExecutionTraceEvents([
      { type: 'turn_usage', data: { inputTokens: 500, outputTokens: 100 } },
      { type: 'turn_settled', data: { holdId: 'h10', released: true } },
    ])
    const line = turnSummaryLine(trace)
    expect(line).toContain('预扣已退回')
    expect(line).not.toContain('-')
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

describe('hasFailedTraceStep（RB-D6② 持久警示判定）', () => {
  it('存在 failed 步骤 → true', () => {
    expect(hasFailedTraceStep([{ status: 'done' }, { status: 'failed' }])).toBe(true)
  })
  it('全部 done / 空数组 → false', () => {
    expect(hasFailedTraceStep([{ status: 'done' }])).toBe(false)
    expect(hasFailedTraceStep([])).toBe(false)
  })
  it('undefined（历史会话无 trace）→ false 不抛错（Review Focus 5）', () => {
    expect(hasFailedTraceStep(undefined)).toBe(false)
  })
})
