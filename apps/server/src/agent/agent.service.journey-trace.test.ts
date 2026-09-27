import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { buildTurnMetadata } from './agent.service'

/**
 * 注：原「journey_update 事件 → metadata.journeyTrace」的流式用例已随老 LangGraph
 * runtime 一起删除——`journey_update` 是 LangGraph 图节点产出的事件类型，pi-runtime
 * 不发它，退役后没有任何链路会产出 journeyTrace。buildTurnMetadata 对 journeyTrace
 * 的支持保留（纯函数，仍被单元测试覆盖；将来 pi 侧若补流程态可直接接回）。
 */

describe('buildTurnMetadata executionTrace', () => {
  it('writes executionTrace to metadata when present', () => {
    const executionTrace = {
      events: [{ kind: 'text_stage' as const, ts: 1, payload: { text: 'hi' } }],
      updatedAt: 1,
    }
    const md = buildTurnMetadata({ executionTrace })
    expect(md?.executionTrace).toEqual(executionTrace)
  })

  it('omits executionTrace when absent', () => {
    const md = buildTurnMetadata({ journeyTrace: undefined })
    expect(md?.executionTrace).toBeUndefined()
  })

  it('coexists with journeyTrace and presentation', () => {
    const executionTrace = {
      events: [{ kind: 'canvas' as const, ts: 5, payload: { nodeId: 'n1' } }],
      updatedAt: 5,
    }
    const journeyTrace = {
      version: 1 as const,
      flowMode: 'product_visual' as const,
      steps: [],
      current: 'done' as const,
      startedAt: '2026-09-18T00:00:00.000Z',
      updatedAt: '2026-09-18T00:01:00.000Z',
    }
    const md = buildTurnMetadata({ executionTrace, journeyTrace, presentation: { foo: 1 } })
    expect(md?.executionTrace).toEqual(executionTrace)
    expect(md?.journeyTrace).toEqual(journeyTrace)
    expect(md?.presentation).toEqual({ foo: 1 })
  })
})
