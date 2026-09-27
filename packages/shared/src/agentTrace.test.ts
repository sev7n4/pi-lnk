import { describe, expect, it } from 'vitest'
import type {
  ExecutionEvent,
  ExecutionEventKind,
  ExecutionTraceState,
} from './agentTrace'

describe('ExecutionTraceState', () => {
  it('roundtrips through JSON', () => {
    const events: ExecutionEvent[] = [
      {
        kind: 'text_stage',
        ts: 1,
        payload: { text: 'hello' },
      },
      {
        kind: 'tool_call',
        ts: 2,
        payload: {
          name: 'arrange_nodes_along_edges',
          args: { nodeIds: ['n1', 'n2'] },
        },
      },
    ]
    const state: ExecutionTraceState = { events, updatedAt: 2 }
    const restored = JSON.parse(JSON.stringify(state)) as ExecutionTraceState
    expect(restored).toEqual(state)
  })

  it('accepts all 5 declared event kinds', () => {
    const kinds: ExecutionEventKind[] = [
      'text_stage',
      'canvas',
      'task',
      'tool_call',
      'macro_select',
    ]
    for (const kind of kinds) {
      const ev: ExecutionEvent = { kind, ts: 0, payload: {} }
      expect(ev.kind).toBe(kind)
    }
  })

  it('preserves executionTrace in AgentMessageMetadata roundtrip', () => {
    const trace: ExecutionTraceState = {
      events: [{ kind: 'canvas', ts: 10, payload: { nodeId: 'n1' } }],
      updatedAt: 10,
    }
    const json = JSON.stringify({ executionTrace: trace })
    const restored = JSON.parse(json) as { executionTrace: ExecutionTraceState }
    expect(restored.executionTrace).toEqual(trace)
  })
})

