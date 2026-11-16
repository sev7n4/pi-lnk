// M1-3 + 内置技能可发现（本刀）技能下拉动态渲染接线守卫（fs-scan，与 AgentSideRail 其他守卫同惯例）。
// 动态合并逻辑本身在 agentSkillMap.test.ts（mergeAgentSkills + runtimeSkillsToInstalled 纯函数）覆盖；
// 此处只锁「下拉数据源=运行时 /skills/runtime ∪ mine（经 mergeAgentSkills 复用合并）+ `/` 候选同源」接线事实。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

describe('AgentSideRail 技能下拉动态渲染（M1-3 + 内置可发现）', () => {
  it('下拉 v-for 用 dockSkills（不再是静态 AGENT_SKILLS）', () => {
    expect(sfc).toContain('v-for="skill in dockSkills"')
    expect(sfc).not.toContain('v-for="skill in AGENT_SKILLS"')
    expect(sfc).toContain('v-if="!dockSkills.length"')
  })

  it('onMounted 拉取：skillApi.runtimeList + skillApi.mine 并源，经 runtimeSkillsToInstalled 适配后复用 mergeAgentSkills', () => {
    expect(sfc).toContain('skillApi.runtimeList()')
    expect(sfc).toContain('skillApi.mine()')
    expect(sfc).toContain('runtimeSkillsToInstalled(runtime)')
    expect(sfc).toContain('mergeAgentSkills(AGENT_SKILLS,')
    expect(sfc).toContain('void loadDockSkills()')
  })

  it('B6 fail-soft：runtime/mine 各自 catch 空数组回退，初始值静态内置兜底（不阻断对话）', () => {
    expect(sfc).toContain('.catch(() => [])')
    expect(sfc).toContain('const dockSkills = ref<AgentSkillDef[]>([...AGENT_SKILLS])')
    // 旧整体 try/catch 已被逐源 catch 取代——不允许把异常吞成整体回退后丢弃 mine
    const block = sfc.slice(sfc.indexOf('async function loadDockSkills'))
    expect(block.slice(0, 600)).not.toContain('try {')
  })

  it('B4 `/` 候选与 `+` 下拉同一数据源（slashSkillOptions 派生自 dockSkills，同一 activeSkillId 出口）', () => {
    expect(sfc).toContain(':slash-options="slashSkillOptions"')
    expect(sfc).toContain('@slash-select="onSlashSkillSelect"')
    expect(sfc).toContain('dockSkills.value.map((s) => ({ id: s.id, label: s.label, desc: s.desc }))')
    expect(sfc).toContain('activeSkillId.value = option.id')
  })
})
