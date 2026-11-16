import { describe, expect, it } from 'vitest'
import {
  AGENT_SKILLS,
  agentInputPlaceholder,
  getAgentSkill,
  mergeAgentSkills,
  runtimeSkillsToInstalled,
} from './agentSkillMap'

const installed = (over: Record<string, unknown> = {}) => ({
  skill: 'task-decomposition', displayName: '任务分解', summary: '拆任务',
  enabled: true, disableModelInvocation: false, userInvocable: true, ...over,
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

  it('userInvocable=false 的技能不进用户点选列表（P12，路由仍可达）', () => {
    const out = mergeAgentSkills(AGENT_SKILLS, [installed({ userInvocable: false })])
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

describe('runtimeSkillsToInstalled + mergeAgentSkills — 内置技能动态并入（B2/B5/B7）', () => {
  const runtime = [
    { name: 'drama-audio-design', description: '配音与声音设计' },
    { name: 'drama-script-writing', description: '剧本创作' },
    { name: 'ecommerce-product-photo', description: '电商商品图' },
    { name: 'html-craft', description: 'HTML 规范' },
    { name: 'research-delegate', description: '调研委派' },
    { name: 'task-decomposition', description: '任务拆解' },
  ]

  it('B2：运行时技能适配后经 mergeAgentSkills 全部进下拉（含 11 项中任意子集）', () => {
    const out = mergeAgentSkills(AGENT_SKILLS, runtimeSkillsToInstalled(runtime))
    for (const r of runtime) {
      expect(out.some((s) => s.runtimeSkillId === r.name)).toBe(true)
    }
    // label/desc 取运行时 name/description（不硬编码）
    const drama = out.find((s) => s.runtimeSkillId === 'drama-script-writing')
    expect(drama).toMatchObject({ id: 'drama-script-writing', label: 'drama-script-writing', desc: '剧本创作' })
  })

  it('与内置同名去重：ecommerce-product-photo 保留内置 UI 短 id（product-visual）', () => {
    const out = mergeAgentSkills(AGENT_SKILLS, runtimeSkillsToInstalled(runtime))
    const entries = out.filter((s) => s.runtimeSkillId === 'ecommerce-product-photo')
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('product-visual')
  })

  it('B7：运行时列表变化界面随之变化——新增名自动出现、移除名自动消失', () => {
    const extended = [...runtime, { name: 'brand-new-skill', description: '新增技能' }]
    const withNew = mergeAgentSkills(AGENT_SKILLS, runtimeSkillsToInstalled(extended))
    expect(withNew.some((s) => s.runtimeSkillId === 'brand-new-skill')).toBe(true)
    const shrunk = mergeAgentSkills(AGENT_SKILLS, runtimeSkillsToInstalled(runtime.slice(0, 2)))
    expect(shrunk.some((s) => s.runtimeSkillId === 'html-craft')).toBe(false)
  })

  it('runtime 为空 + mine 为空 → 原样返回内置（B6 fail-soft 兜底逐字节不变）', () => {
    expect(mergeAgentSkills(AGENT_SKILLS, runtimeSkillsToInstalled([]))).toEqual(AGENT_SKILLS)
  })

  it('运行时项与已装项可同时并入（各自过滤规则互不影响）', () => {
    const out = mergeAgentSkills(AGENT_SKILLS, [
      ...runtimeSkillsToInstalled(runtime),
      installed({ skill: 'my-custom-skill', displayName: '我的自定义', summary: '粘贴装' }),
      installed({ skill: 'off-skill', displayName: '已关闭', enabled: false }),
    ])
    expect(out.some((s) => s.runtimeSkillId === 'my-custom-skill')).toBe(true)
    expect(out.some((s) => s.runtimeSkillId === 'off-skill')).toBe(false)
  })
})
