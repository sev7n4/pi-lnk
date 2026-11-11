import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentStore } from '@/stores/agent'
import { replayExecutionTraceEvents } from './executionTraceReducer'

const rail = readFileSync(resolve(__dirname, './AgentSideRail.vue'), 'utf8')
const timeline = readFileSync(resolve(__dirname, './AgentTurnTimeline.vue'), 'utf8')
const trace = readFileSync(resolve(__dirname, './executionTraceReducer.ts'), 'utf8')

describe('turn_interrupted 前端接线', () => {
  it('handleEvent 有 case 且喂入 timeline（不是静默丢弃）', () => {
    expect(rail).toMatch(/case 'turn_interrupted'/)
    expect(rail).toMatch(/feedTimeline\(/)
  })

  it('不追加「连接意外断开」文案（与 turn_suspended 同款豁免）', () => {
    const start = rail.indexOf("case 'turn_interrupted'")
    expect(start).toBeGreaterThan(-1)
    const caseBody = rail.slice(start, start + 700)
    expect(caseBody).not.toContain('appendText')
    expect(caseBody).not.toContain('连接意外断开')
  })

  it('挂载点接了 @retry-turn', () => {
    expect(rail).toMatch(/@retry-turn=/)
  })

  it('工具卡有 interrupted 渲染分支（禁止 ✓）', () => {
    expect(timeline).toMatch(/part\.status === 'interrupted'/)
  })

  it('trace 状态枚举含 interrupted', () => {
    expect(trace).toMatch(/'interrupted'/)
  })

  it('挂起互斥：turn_suspended case 仍在，且中断 case 不设置 mainTurnSuspended', () => {
    expect(rail).toMatch(/case 'turn_suspended'/)
    const start = rail.indexOf("case 'turn_interrupted'")
    expect(rail.slice(start, start + 700)).not.toContain('mainTurnSuspended.value = true')
  })
})

/**
 * 行为级回归锁（2026-11-11 实施期补）：
 * 上面 6 条是源码级断言，只能证明「写了对的字符串」——曾出现过 `feedTimeline` 根本
 * 没在 store return 里导出、源码断言却全绿的假绿风险。这里直接跑 store / reducer，
 * 钉住实时与重放两条路径真的把工具卡判成 interrupted（而不是 done/✓）。
 */
describe('turn_interrupted 实时 / 重放行为（防源码级假绿）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('feedTimeline 是 store 公开动作：running 工具 → interrupted + 稳定 id notice', () => {
    const s = useAgentStore()
    s.addUserMessage('调研 X')
    s.startAssistantMessage()
    s.beginToolCall({ toolCallId: 'call_A', name: 'spawn_subagent', args: { task: 'X' } })

    const last = () => s.messages[s.messages.length - 1]
    expect(last().timeline?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'tool', status: 'running' })]),
    )
    expect(typeof s.feedTimeline).toBe('function')

    s.feedTimeline({ type: 'turn_interrupted', data: { reason: 'no_terminal_event' } })

    expect(last().timeline?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'tool', status: 'interrupted' })]),
    )
    expect(
      last().timeline?.parts.filter((p) => p.kind === 'notice' && p.id === 'notice:turn-interrupted'),
    ).toHaveLength(1)
    // 回落视图（flag 关闭时的 AgentExecutionTrace）必须由同一漏斗同步，不能再显示 ✓
    expect(last().executionTrace?.steps.filter((st) => st.kind === 'tool')).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'interrupted' })]),
    )
  })

  it('feedTimeline 重复下发幂等：notice 不叠加', () => {
    const s = useAgentStore()
    s.addUserMessage('调研 X')
    s.startAssistantMessage()
    s.beginToolCall({ toolCallId: 'call_A', name: 'spawn_subagent' })
    s.feedTimeline({ type: 'turn_interrupted', data: { reason: 'no_terminal_event' } })
    s.feedTimeline({ type: 'turn_interrupted', data: { reason: 'no_terminal_event' } })
    expect(
      s.messages[s.messages.length - 1].timeline?.parts.filter(
        (p) => p.kind === 'notice' && p.id === 'notice:turn-interrupted',
      ),
    ).toHaveLength(1)
  })

  it('重放路径：executionEvents 里的 turn_interrupted 让工具步跳过 finalize 的 done 兜底', () => {
    const withInterrupt = replayExecutionTraceEvents([
      { type: 'tool_call', data: { name: 'spawn_subagent', toolCallId: 'call_A', args: { task: 'X' } } },
      { type: 'turn_interrupted', data: { reason: 'no_terminal_event' } },
    ])
    const tool = withInterrupt.steps.find((st) => st.kind === 'tool')
    expect(tool?.status).toBe('interrupted')
    // 中断没有「完成耗时」；留空才能避免复刻「✓ 用时 0ms」
    expect(tool?.ms).toBeUndefined()

    // 变异对照：删掉事件，旧行为确实会翻成 done —— 证明本断言不是恒真
    const withoutInterrupt = replayExecutionTraceEvents([
      { type: 'tool_call', data: { name: 'spawn_subagent', toolCallId: 'call_A', args: { task: 'X' } } },
    ])
    expect(withoutInterrupt.steps.find((st) => st.kind === 'tool')?.status).toBe('done')
  })
})
