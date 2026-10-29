import { describe, expect, it } from 'vitest'
import { describeActivityFromTimeline } from '@/components/agent/activityLine'
import { createTurnTimeline, applyTimelineEvent } from '@/components/agent/turnTimeline'

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
