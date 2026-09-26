import { describe, expect, it } from 'vitest'
import {
  AGENT_SKILLS,
  agentInputPlaceholder,
  getAgentSkill,
} from './agentSkillMap'

describe('agentSkillMap', () => {
  it('lists only backend-connected skills', () => {
    expect(AGENT_SKILLS.length).toBeGreaterThan(0)
    for (const skill of AGENT_SKILLS) {
      expect(skill.runtimeSkillId).toBeTruthy()
    }
  })

  it('getAgentSkill returns undefined for auto mode', () => {
    expect(getAgentSkill(null)).toBeUndefined()
    expect(getAgentSkill(undefined)).toBeUndefined()
    expect(getAgentSkill('')).toBeUndefined()
  })

  it('getAgentSkill resolves product-visual → pi 侧真实技能名', () => {
    expect(getAgentSkill('product-visual')?.runtimeSkillId).toBe('ecommerce-product-photo')
  })

  it('未迁移的老技能（canvas/enterprise-marketing-campaign）不在 dock 列表', () => {
    expect(getAgentSkill('canvas')).toBeUndefined()
    expect(AGENT_SKILLS.some((s) => s.runtimeSkillId === 'enterprise-marketing-campaign')).toBe(
      false,
    )
  })

  it('placeholder differs for auto vs skill', () => {
    expect(agentInputPlaceholder(undefined)).toContain('@')
    expect(agentInputPlaceholder(getAgentSkill('product-visual'))).toContain('实物产品视觉出图')
  })
})
