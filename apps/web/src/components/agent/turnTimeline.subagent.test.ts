import { describe, it, expect } from 'vitest'
import {
  applyTimelineEvent,
  createTurnTimeline,
  finalizeTurnTimeline,
  type TimelineEvent,
  type TimelinePart,
  type TurnTimeline,
} from '@/components/agent/turnTimeline'

type SubagentPart = Extract<TimelinePart, { kind: 'subagent_task' }>

function feed(events: TimelineEvent[]): TurnTimeline {
  const tl = createTurnTimeline()
  for (const e of events) applyTimelineEvent(tl, e)
  return tl
}

function subagentParts(tl: TurnTimeline): SubagentPart[] {
  return tl.parts.filter((p): p is SubagentPart => p.kind === 'subagent_task')
}

const TASK_TEXT = '调研 Tavily 免费计划配额：查官网定价页与 FAQ，回答每月 API credits 额度。'
const REPORT_TEXT = 'Tavily 免费档 Researcher，1,000 credits/月。Search basic 每次 1 credit。来源：https://tavily.com/#pricing'

function blockEvents(overrides?: { status?: string; report?: string; partial?: boolean }): TimelineEvent[] {
  return [
    {
      type: 'tool_call',
      data: {
        toolCallId: 'tc-block-1',
        name: 'spawn_subagent',
        args: { task: TASK_TEXT, background: '已读过旧资料', mode: 'block' },
      },
    },
    {
      type: 'tool_result',
      data: {
        toolCallId: 'tc-block-1',
        name: 'spawn_subagent',
        result: {
          ok: true,
          callId: 'call-block-1',
          report: overrides?.report ?? REPORT_TEXT,
          usage: { turns: 4, durationMs: 59000, status: overrides?.status ?? 'completed' },
          partial: overrides?.partial,
        },
      },
    },
  ]
}

describe('turnTimeline — 子代理任务可见性（spec 2026-11-17）', () => {
  it('C1：block spawn 的 tool_call + tool_result 派生一张 subagent_task 卡，含完整 task/report', () => {
    const tl = feed(blockEvents())
    const parts = subagentParts(tl)
    expect(parts).toHaveLength(1)
    const p = parts[0]
    expect(p.status).toBe('completed')
    expect(p.durationMs).toBe(59000)
    expect(p.turns).toBe(4)
    expect(p.callId).toBe('call-block-1')
    expect(p.task).toContain(TASK_TEXT)
    expect(p.task).toContain('已读过旧资料')
    expect(p.report).toBe(REPORT_TEXT)
  })

  it('C2：background spawn(running) + collect(terminal, 同 callId) 收敛到终态', () => {
    const tl = feed([
      {
        type: 'tool_call',
        data: { toolCallId: 'tc-bg-1', name: 'spawn_subagent', args: { task: TASK_TEXT, mode: 'background' } },
      },
      {
        type: 'tool_result',
        data: {
          toolCallId: 'tc-bg-1',
          name: 'spawn_subagent',
          result: { ok: true, callId: 'call-bg-1', status: 'running' },
        },
      },
      {
        type: 'tool_call',
        data: { toolCallId: 'tc-collect-1', name: 'collect_subagent_result', args: { callId: 'call-bg-1' } },
      },
      {
        type: 'tool_result',
        data: {
          toolCallId: 'tc-collect-1',
          name: 'collect_subagent_result',
          result: {
            ok: true,
            callId: 'call-bg-1',
            status: 'completed',
            report: REPORT_TEXT,
            usage: { turns: 6, durationMs: 120000, status: 'completed' },
          },
        },
      },
    ])
    const parts = subagentParts(tl)
    expect(parts).toHaveLength(1)
    expect(parts[0].status).toBe('completed')
    expect(parts[0].report).toBe(REPORT_TEXT)
    expect(parts[0].durationMs).toBe(120000)
  })

  it('C3：stream_interrupted + partial 标记透传，不冒充成功', () => {
    const tl = feed(blockEvents({ status: 'stream_interrupted', report: '半截结论', partial: true }))
    const parts = subagentParts(tl)
    expect(parts).toHaveLength(1)
    expect(parts[0].status).toBe('stream_interrupted')
    expect(parts[0].partial).toBe(true)
    expect(parts[0].report).toBe('半截结论')
  })

  it('C4：background spawn 无 collect，回合结束时标 degraded（结果已并入回复兜底）', () => {
    const tl = feed([
      {
        type: 'tool_call',
        data: { toolCallId: 'tc-bg-2', name: 'spawn_subagent', args: { task: TASK_TEXT, mode: 'background' } },
      },
      {
        type: 'tool_result',
        data: {
          toolCallId: 'tc-bg-2',
          name: 'spawn_subagent',
          result: { ok: true, callId: 'call-bg-2', status: 'running' },
        },
      },
    ])
    expect(subagentParts(tl)[0].degraded).toBeUndefined() // 回合未结束不预判
    finalizeTurnTimeline(tl)
    const parts = subagentParts(tl)
    expect(parts).toHaveLength(1)
    expect(parts[0].degraded).toBe(true)
    expect(parts[0].report).toBeUndefined()
  })

  it('C5：重复事件（重连/重放）幂等，仍一张卡', () => {
    const events = blockEvents()
    const tl = feed([...events, ...events])
    expect(subagentParts(tl)).toHaveLength(1)
  })

  it('C6：非子代理工具不产生 subagent_task，原 tool part 仍在', () => {
    const tl = feed([
      { type: 'tool_call', data: { toolCallId: 'tc-x', name: 'run_text_generation', args: { prompt: 'X' } } },
      {
        type: 'tool_result',
        data: { toolCallId: 'tc-x', name: 'run_text_generation', result: { message: 'done' } },
      },
    ])
    expect(subagentParts(tl)).toHaveLength(0)
    expect(tl.parts.some((p) => p.kind === 'tool' && p.toolName === 'run_text_generation')).toBe(true)
  })

  it('C7：短码名来自 callId 前 8 位，任务摘要取 task 前 20 字', () => {
    const tl = feed(blockEvents())
    const p = subagentParts(tl)[0]
    expect(p.displayName).toBe('子代理 call-blo')
    expect(p.taskSummary).toBe(TASK_TEXT.slice(0, 20))
  })

  it('C8：block 工具失败（无 report）仍产卡，status 从 error 映射', () => {
    const tl = feed([
      {
        type: 'tool_call',
        data: { toolCallId: 'tc-f', name: 'spawn_subagent', args: { task: TASK_TEXT } },
      },
      {
        type: 'tool_result',
        data: {
          toolCallId: 'tc-f',
          name: 'spawn_subagent',
          isError: true,
          result: { ok: false, error: 'subagent_concurrency_full', callId: 'call-f' },
        },
      },
    ])
    const parts = subagentParts(tl)
    expect(parts).toHaveLength(1)
    expect(parts[0].status).toBe('failed')
  })
})
