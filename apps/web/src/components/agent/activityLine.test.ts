import { describe, expect, it } from 'vitest'
import { describeActivity, describeActivityFromTimeline } from '@/components/agent/activityLine'
import type { ExecutionStep } from '@/components/agent/executionTraceReducer'
import { createTurnTimeline, applyTimelineEvent } from '@/components/agent/turnTimeline'

function step(over: Partial<ExecutionStep>): ExecutionStep {
  return { id: 's1', kind: 'tool', label: '调用 upsert_media_node', status: 'running', ...over }
}

describe('describeActivityFromTimeline（根治规格 2026-10-28：activity 单一真相 = 时间线）', () => {
  /** 从事件流构造 parts（复用模型层 reducer，避免手写 part 假数据漂移）。 */
  function partsFrom(events: Parameters<typeof applyTimelineEvent>[1][]) {
    const tl = createTurnTimeline()
    for (const e of events) applyTimelineEvent(tl, e)
    return tl.parts
  }

  it('最新 tool part → 注册表动词（与对话流内联卡同源）', () => {
    const parts = partsFrom([
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'upsert_media_node', args: {} } },
    ])
    expect(describeActivityFromTimeline(parts)).toBe('创建节点')
  })

  it('取最后一个非失败 tool part；failed 跳过', () => {
    const parts = partsFrom([
      { type: 'tool_call', data: { toolCallId: 'c1', name: 'arrange_nodes', args: {} } },
      { type: 'tool_result', data: { toolCallId: 'c1', name: 'arrange_nodes', result: {}, isError: true } },
      { type: 'tool_call', data: { toolCallId: 'c2', name: 'upsert_media_node', args: {} } },
    ])
    expect(describeActivityFromTimeline(parts)).toBe('创建节点')
  })

  it('无 tool part / undefined → null（上层降级为「处理中」）', () => {
    expect(describeActivityFromTimeline(undefined)).toBeNull()
    expect(describeActivityFromTimeline([])).toBeNull()
    const noTool = partsFrom([{ type: 'thinking', data: { status: 'running' } }])
    expect(describeActivityFromTimeline(noTool)).toBeNull()
  })
})

describe('describeActivity（「正在做什么」人话）', () => {
  it('最新工具步 → 注册表动词', () => {
    expect(describeActivity([step({ kind: 'tool', meta: { toolName: 'upsert_media_node' } })]))
      .toBe('创建节点')
  })
  it('跳过 phase 门控步骤，取最新真实动作', () => {
    const steps = [
      step({ kind: 'phase', label: '生成门控', status: 'waiting_user' }),
      step({ kind: 'tool', meta: { toolName: 'arrange_nodes' } }),
    ]
    expect(describeActivity(steps)).toBe('整理布局')
  })
  it('thinking 步 → 思考中', () => {
    expect(describeActivity([step({ kind: 'thinking', label: '思考中…' })])).toBe('思考中…')
  })
  it('无步骤 / undefined → null（上层降级为「处理中」）', () => {
    expect(describeActivity([])).toBeNull()
    expect(describeActivity(undefined)).toBeNull()
  })
})
