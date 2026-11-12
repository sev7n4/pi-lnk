import { describe, expect, it } from 'vitest'
import {
  interruptedOutcome, isSpawnToolFrame, parseSubagentOutcome,
} from './subagent-task.status'

/**
 * 生产只读快照夹具（2026-11-11，lnkpi-api SQLite AgentMessage.metadata + AgentEvent）。
 * A = cmwbvfp4p000qrk01pch77w13（故障会话，pod 在 tool_call 后 0.4s 被替换）
 * B = …42ap2hej（同工具正常返回，78.9s 后有完整 tool_result）
 * 已脱敏：仅保留形态所需字段。
 */
const A_TOOL_CALL = {
  toolCallId: 'call_334ae8e2832146608be265e9',
  name: 'spawn_subagent', toolName: 'spawn_subagent',
  args: { task: '调研市场竞品' },
}
const A_INTERRUPTED_DATA = {
  reason: 'no_terminal_event', lastSeq: 152,
  outstandingToolCallIds: ['call_334ae8e2832146608be265e9'],
}
// spawn-subagent.ts textResult 的 details 即返回值；tool_execution_end.result.details 原样透传
const B_TOOL_RESULT = {
  toolCallId: 'call_b55c3b4616434aada4967bf4',
  name: 'spawn_subagent', toolName: 'spawn_subagent',
  result: {
    content: [{ type: 'text', text: '{"ok":true,"report":"R"}' }],
    details: {
      ok: true, report: 'R',
      usage: { turns: 3, durationMs: 78900, status: 'completed' },
    },
  },
  isError: false,
}

describe('D2：贴真实生产记录求值', () => {
  it('A（阳性）：tool_call 是 spawn 帧；中断 data 命中同一 callId', () => {
    expect(isSpawnToolFrame({ type: 'tool_call', data: A_TOOL_CALL })).toBe(true)
    expect(A_INTERRUPTED_DATA.outstandingToolCallIds).toContain(A_TOOL_CALL.toolCallId)
  })

  it('B（阴性）：正常 tool_result 解析为 completed，summary 不含 report 全文', () => {
    const o = parseSubagentOutcome(B_TOOL_RESULT.result)
    expect(o?.status).toBe('completed')
    expect(o?.reason).toBe('completed')
    expect(o?.summary.turns).toBe(3)
    expect(JSON.stringify(o)).not.toContain('"report":"R"')
  })
})

describe('D2：变异自检（每项必须能 RED）', () => {
  it('M1 把 usage.status 改 timeout ⇒ 终态变 timeout', () => {
    const r = structuredClone(B_TOOL_RESULT.result)
    ;(r.details.usage as { status: string }).status = 'timeout'
    expect(parseSubagentOutcome(r)?.status).toBe('timeout')
  })

  it('M2 failed 形态：ok:false + error:subagent_failed ⇒ failed', () => {
    const r = {
      content: [{ type: 'text', text: '{}' }],
      details: { ok: false, error: 'subagent_failed', report: '',
        usage: { turns: 1, durationMs: 10, status: 'failed' } },
    }
    expect(parseSubagentOutcome(r)?.status).toBe('failed')
  })

  it('M3 budget_exceeded 形态 ⇒ 原样透传，不塌成 failed', () => {
    const r = { details: { ok: false, error: 'subagent_budget_exceeded',
      usage: { turns: 30, durationMs: 100, status: 'budget_exceeded' } } }
    expect(parseSubagentOutcome(r)?.status).toBe('budget_exceeded')
  })

  it('M4 去掉 result.details（老 runtime 形态）⇒ null，不硬编码 completed', () => {
    expect(parseSubagentOutcome({ content: [{ type: 'text', text: 'ok' }] })).toBeNull()
  })

  it('M5 非 spawn 工具帧 ⇒ false（漏斗零副作用判据）', () => {
    expect(isSpawnToolFrame({ type: 'tool_call', data: { name: 'get_canvas_summary' } })).toBe(false)
    expect(isSpawnToolFrame({ type: 'tool_result', data: { name: 'get_canvas_summary' } })).toBe(false)
  })

  it('M6 interruptedOutcome 恒为中性 reason，不臆断 pod 重启', () => {
    const o = interruptedOutcome('no_terminal_event')
    expect(o.status).toBe('interrupted')
    expect(o.reason).toBe('no_terminal_event')
    expect(JSON.stringify(o)).not.toMatch(/pod|restart|disconnect/i)
  })
})
