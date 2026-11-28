import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = readFileSync(`${process.cwd()}/src/components/agent/AgentSideRail.vue`, 'utf8')

describe('AgentSideRail：重复意图拒绝的强制重发接线', () => {
  it('turn_not_submitted 识别 duplicate_intent 并记下被拒原话', () => {
    expect(src).toContain("d.reason === 'duplicate_intent'")
    expect(src).toContain("agent.setTurnRefusal('duplicate_intent'")
    expect(src).toContain('message: lastSubmittedMessage')
  })

  it('callout 提供「仍要发送」出口，且 force=true 重发', () => {
    expect(src).toContain('turn-refusal-force-resend')
    expect(src).toContain('仍要发送')
    expect(src).toContain('resendRefused()')
    expect(src).toContain('sendMessage(msg, undefined, true, true)')
  })

  it('sendMessage 末位 force 透传到 postConversation payload', () => {
    expect(src).toContain('async function sendMessage(message: string, branchFromEntryId?: string, isRetry = false, force = false)')
    expect(src).toContain('force: force || undefined')
  })

  it('旧 not_idle / not_steerable 文案仍在（契约不回归）', () => {
    expect(src).toContain('你的消息已并入进行中的任务')
    expect(src).toContain('当前任务无法插话')
  })
})
