import { describe, expect, it } from 'vitest'
import { AGENT_INPUT_PLACEHOLDER_AUTO, agentInputPlaceholder, AGENT_SKILLS } from './agentSkillMap'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FORBIDDEN = /Cmd\/Ctrl|Ctrl \+|Cmd \+|回车|Enter/i

describe('composer placeholder keyboard copy ban (P0-1.2)', () => {
  it('auto placeholder describes capability, not keyboard', () => {
    expect(FORBIDDEN.test(AGENT_INPUT_PLACEHOLDER_AUTO)).toBe(false)
    expect(AGENT_INPUT_PLACEHOLDER_AUTO).toContain('@')
  })
  it('skill placeholder describes capability, not keyboard', () => {
    for (const s of AGENT_SKILLS) expect(FORBIDDEN.test(agentInputPlaceholder(s))).toBe(false)
  })
  it('streaming placeholder in AgentSideRail has no keyboard words', () => {
    const sfc = readFileSync(join(__dirname, '../components/agent/AgentSideRail.vue'), 'utf8')
    expect(sfc).not.toContain('回车加入待发队列')
    expect(sfc).toContain('加入待发队列')
  })
})
