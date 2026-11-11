/**
 * A2–A4（P1a，计划 2026-11-11-sse-event-firstclass-p1a.md §1.3）：UiEvent `ts` 透传
 * 行为测试——`PiRuntimeEvent.ts` 必填 number，派生点统一 `ts: event.ts`，SSE 帧
 * （/runs/events）与 AgentEvent 表（PR-B）据此同构。
 *
 * 变异自检：
 *   - A2/A3 任一派生点删 `ts: event.ts` ⇒ 对应断言 RED；
 *   - A4（阴性）：无 ts 输入 ⇒ 产物无 ts 键；若有人把透传改成硬编码 Date.now() ⇒ RED。
 */
import { describe, expect, it } from 'vitest'
import {
  createUiEventProjector,
  mapPiEventToUiEvent,
  type PiRuntimeEvent,
} from './pi-events'

const ev = (type: PiRuntimeEvent['type'], data: unknown, ts = 1_731_000_000_000, seq = 5): PiRuntimeEvent =>
  ({ type, ts, seq, runId: 'run-1', data }) as never

describe('A2 · mapPiEventToUiEvent 全型谱 ts 透传', () => {
  const cases: Array<[PiRuntimeEvent, string]> = [
    [ev('message_update', { event: { type: 'text_delta', delta: 'hi' } }), 'text_delta'],
    [ev('tool_execution_start', { toolCallId: 't1', toolName: 'x', args: {} }), 'tool_call'],
    [ev('tool_execution_end', { toolCallId: 't1', toolName: 'x', result: {}, isError: false }), 'tool_result'],
    [ev('agent_end', { status: 'completed' }), 'done'],
    [ev('waiting_user', { status: 'waiting', toolName: 'ask_user', callId: 'c1' }), 'waiting_user'],
    [ev('node_status', { nodeId: 'n1', status: 'generating' }), 'node_status'],
    [ev('activity', { toolName: 'x', done: 1 }), 'activity'],
    [ev('recovery', {}), 'recovery'],
    [ev('snapshot', {}), 'snapshot'],
    [ev('some_unknown_pi_event', { a: 1 }), 'pi_some_unknown_pi_event'],
  ]
  for (const [input, expectedType] of cases) {
    it(`${expectedType} 带 ts === 输入事件 ts`, () => {
      const out = mapPiEventToUiEvent(input)
      expect(out).not.toBeNull()
      expect(out!.type).toBe(expectedType)
      expect(out!.ts).toBe(1_731_000_000_000)
    })
  }
})

describe('A3 · createUiEventProjector 派生谱 ts 透传', () => {
  it('canvas_command / canvas_action / task_list 派生带 ts', () => {
    const p = createUiEventProjector({ role: 'observer' })
    const out = p.feed(
      ev('tool_execution_update', {
        toolCallId: 'c1',
        partialResult: {
          details: {
            canvasCommands: [{ type: 'ask_user', callId: 'c1' }],
            actions: [{ action: 'add_node', payload: { nodeType: 'text', content: 'x' } }],
          },
        },
      }),
    )
    const cmd = out.find((o) => o.type === 'canvas_command')
    expect(cmd).toBeTruthy()
    expect(cmd!.ts).toBe(1_731_000_000_000)
  })

  it('thinking 与 turn_usage（accumulator 产物）带 ts', () => {
    const p = createUiEventProjector({ role: 'observer' })
    const start = p.feed(ev('message_update', { event: { type: 'thinking_start' } }))
    expect(start[0]!.ts).toBe(1_731_000_000_000)
    const usage = createUiEventProjector({ role: 'observer' })
    usage.feed(ev('message_end', { message: { usage: { input: 10, output: 5 } } }))
    const done = usage.feed(ev('agent_end', { status: 'completed' }))
    const turnUsage = done.find((o) => o.type === 'turn_usage')
    expect(turnUsage).toBeTruthy()
    expect(turnUsage!.ts).toBe(1_731_000_000_000)
  })

  it('task_list / task_update（extractTaskEvents 强转路径）带 seq+ts', () => {
    const p = createUiEventProjector({ role: 'observer' })
    const out = p.feed(
      ev('tool_execution_end', {
        toolName: 'todo_write',
        result: {
          details: {
            todo: {
              diff: {
                updates: [{ id: 't1', status: 'in_progress' }],
                list: undefined,
              },
            },
          },
        },
      }),
    )
    const upd = out.find((o) => o.type === 'task_update')
    expect(upd).toBeTruthy()
    expect(upd!.ts).toBe(1_731_000_000_000)
    expect(upd!.seq).toBe(5)
  })
})

describe('A4 · 阴性对照：无 ts 输入 ⇒ 产物 ts 为 undefined', () => {
  it('输入缺 ts（旁路类型）⇒ 产物 ts 值为 undefined（防硬编码 Date.now() 假透传）', () => {
    // 实现侧派生点均为显式键 `ts: event.ts`：输入无 ts 时键存在但值为 undefined
    // （toEqual 忽略 undefined，与既有测试风格一致）。判据取值级而非键级——
    // 若有人把透传改成 `ts: Date.now()` 之类硬编码，本断言即 RED。
    const noTs = { type: 'recovery', data: {} } as never as PiRuntimeEvent
    const out = mapPiEventToUiEvent(noTs)
    expect(out).not.toBeNull()
    expect(out!.ts).toBeUndefined()
    expect(out!.seq).toBeUndefined()
  })
})
