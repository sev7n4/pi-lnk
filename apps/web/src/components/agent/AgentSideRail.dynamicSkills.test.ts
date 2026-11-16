// M1-3 技能下拉动态渲染接线守卫（fs-scan，与 AgentSideRail 其他守卫同惯例）。
// 动态合并逻辑本身在 agentSkillMap.test.ts（mergeAgentSkills 纯函数）覆盖；
// 此处只锁「下拉数据源已从静态 AGENT_SKILLS 切到 dockSkills + onMounted 拉取」这一接线事实。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

describe('AgentSideRail 技能下拉动态渲染（M1-3）', () => {
  it('下拉 v-for 用 dockSkills（不再是静态 AGENT_SKILLS）', () => {
    expect(sfc).toContain('v-for="skill in dockSkills"')
    expect(sfc).not.toContain('v-for="skill in AGENT_SKILLS"')
    expect(sfc).toContain('v-if="!dockSkills.length"')
  })

  it('onMounted 拉取用户技能：skillApi.mine + mergeAgentSkills', () => {
    expect(sfc).toContain('skillApi.mine()')
    expect(sfc).toContain('mergeAgentSkills(AGENT_SKILLS, mine)')
    expect(sfc).toContain('void loadDockSkills()')
  })

  it('fail-soft：加载异常回退静态内置（不阻断对话）', () => {
    // catch 分支把 dockSkills 还原为静态 AGENT_SKILLS
    const catchBlock = sfc.slice(sfc.indexOf('async function loadDockSkills'))
    expect(catchBlock.slice(0, 400)).toContain('catch')
    expect(catchBlock.slice(0, 400)).toContain('[...AGENT_SKILLS]')
  })
})
