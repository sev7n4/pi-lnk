// F3（2026-11-17 P3 真机四缺陷）发现页「技能」→ 底部 sheet 接线守卫（fs-scan）。
// D3 根因：技能面板内嵌在「敬请期待」区、处于长社区流之后（实测 rect.y=1388 / 视口 844），
// 点了不滚动、看不见。修复：DiscoverPane 改 emit open-skill-center，壳层以 MobileSheet
// （现成底部 sheet 基座：Teleport + 遮罩 + safe-area）承载同一 SkillDiscoverPanel（market tab）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const pane = readFileSync(join(here, 'DiscoverPane.vue'), 'utf8')
const shell = readFileSync(join(here, 'MobileCanvasShell.vue'), 'utf8')

describe('F3 发现页技能进技能中心', () => {
  it('DiscoverPane 点技能 emit open-skill-center，内嵌面板退役', () => {
    expect(pane).toContain("'open-skill-center': []")
    expect(pane).toContain("if (row.key === 'skills') emit('open-skill-center')")
    expect(pane).not.toContain('skillsOpen')
    expect(pane).not.toContain('discover-skills-panel')
  })

  it('壳层接 emit → 打开技能中心 sheet（复用 MobileSheet + SkillDiscoverPanel）', () => {
    expect(shell).toContain('@open-skill-center="showSkillCenterSheet = true"')
    expect(shell).toContain('const showSkillCenterSheet = ref(false)')
    expect(shell).toContain('<MobileSheet')
    // 二轮 R4（2026-11-18）：接线内置技能区（multiline 形态）——市场空目录不再死胡同
    expect(shell).toContain('<SkillDiscoverPanel')
    expect(shell).toContain('initial-tab="market"')
    expect(shell).toContain(':builtin-skills="dockSkills.map((s) => ({ id: s.id, label: s.label, desc: s.desc }))"')
    expect(shell).toContain('@close="showSkillCenterSheet = false"')
  })

  it('壳层不重复拉 runtime / 不硬编码内置技能（吃满上游，委托 useDockSkills 单一事实源）', () => {
    // 二轮 R4：加载逻辑收敛进 useDockSkills 组合式，壳层只消费——禁直接 skillApi 调用
    expect(shell).not.toContain('skillApi')
    expect(shell).not.toContain('runtimeList')
    expect(shell).not.toContain('AGENT_SKILLS')
    expect(shell).toContain("import { useDockSkills } from '@/composables/useDockSkills'")
  })
})
