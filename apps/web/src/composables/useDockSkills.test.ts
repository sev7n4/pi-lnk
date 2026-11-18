// 二轮 R4（2026-11-18）：useDockSkills 组合式单元守卫——
// AgentSideRail 与 MobileCanvasShell 共用同一数据源（runtime ∪ mine 合并内置兜底，fail-soft）。
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { runtimeList, mine } = vi.hoisted(() => ({
  runtimeList: vi.fn(),
  mine: vi.fn(),
}))
vi.mock('@/services/skill-api', () => ({
  skillApi: { runtimeList, mine },
}))

import { useDockSkills } from './useDockSkills'
import { AGENT_SKILLS } from '@/constants/agentSkillMap'

describe('useDockSkills — 单一数据源组合式（R4）', () => {
  beforeEach(() => {
    runtimeList.mockReset()
    mine.mockReset()
  })

  it('初始值 = 内置兜底（异步加载完成前技能列表可用，M0 行为不回退）', () => {
    const { dockSkills } = useDockSkills()
    expect(dockSkills.value.length).toBe(AGENT_SKILLS.length)
    expect(dockSkills.value.map((s) => s.id)).toEqual(AGENT_SKILLS.map((s) => s.id))
  })

  it('加载成功：runtime + mine 并入（形状适配与合并全部复用既有助手）', async () => {
    runtimeList.mockResolvedValue([{ name: 'runtime-alpha', description: '运行时技能甲' }])
    mine.mockResolvedValue([
      { id: 'row-1', skill: 'user-beta', displayName: '用户技能乙', summary: 's', enabled: true, publisher: 'u', version: '1.0', compatProfile: 'C0', disableModelInvocation: false, userInvocable: true, sourceType: 'paste', trustLevel: 'reviewed', installedAt: '', pinnedHash: '' },
    ])
    const { dockSkills, loadDockSkills } = useDockSkills()
    await loadDockSkills()
    const ids = dockSkills.value.map((s) => s.id)
    expect(ids).toContain('runtime-alpha')
    expect(ids).toContain('user-beta')
    expect(ids.length).toBeGreaterThanOrEqual(AGENT_SKILLS.length)
  })

  it('fail-soft：runtime 挂 → 空数组回退（不阻断）；mine 挂同理', async () => {
    runtimeList.mockRejectedValue(new Error('net down'))
    mine.mockResolvedValue([])
    const { dockSkills, loadDockSkills } = useDockSkills()
    await expect(loadDockSkills()).resolves.toBeUndefined()
    expect(dockSkills.value.map((s) => s.id)).toEqual(AGENT_SKILLS.map((s) => s.id))
  })
})
