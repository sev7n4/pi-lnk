import { describe, expect, it } from 'vitest'
import {
  AGENT_SKILLS,
  agentInputPlaceholder,
  getAgentSkill,
  mergeAgentSkills,
} from './agentSkillMap'

const installed = (over: Record<string, unknown> = {}) => ({
  skill: 'task-decomposition', displayName: '任务分解', summary: '拆任务',
  enabled: true, disableModelInvocation: false, ...over,
})

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

describe('mergeAgentSkills — M1-3 用户技能动态并入下拉', () => {
  it('内置打头 + 用户已启用技能追加（runtimeSkillId=技能名，供 forceSkills pass-through）', () => {
    const out = mergeAgentSkills(AGENT_SKILLS, [installed()])
    expect(out[0]).toEqual(AGENT_SKILLS[0]) // 内置保持首位，不破坏既有默认
    const user = out.find((s) => s.id === 'task-decomposition')
    expect(user).toMatchObject({ label: '任务分解', runtimeSkillId: 'task-decomposition' })
  })

  it('enabled=false 的用户技能不进下拉（关闭态不渲染启用卡片）', () => {
    const out = mergeAgentSkills(AGENT_SKILLS, [installed({ enabled: false })])
    expect(out.some((s) => s.id === 'task-decomposition')).toBe(false)
  })

  it('disableModelInvocation=true 的技能不进隐式下拉（避免选了不生效）', () => {
    const out = mergeAgentSkills(AGENT_SKILLS, [installed({ disableModelInvocation: true })])
    expect(out.some((s) => s.id === 'task-decomposition')).toBe(false)
  })

  it('与内置同 runtime 名的用户技能去重，保留内置（内置是事实源）', () => {
    const out = mergeAgentSkills(AGENT_SKILLS, [installed({ skill: 'ecommerce-product-photo' })])
    expect(out.filter((s) => s.runtimeSkillId === 'ecommerce-product-photo')).toHaveLength(1)
  })

  it('未知技能集为空 → 原样返回内置（M0 行为逐字节不变）', () => {
    expect(mergeAgentSkills(AGENT_SKILLS, [])).toEqual(AGENT_SKILLS)
  })
})
