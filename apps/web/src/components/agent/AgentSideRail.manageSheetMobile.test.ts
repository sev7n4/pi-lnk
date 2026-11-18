// 二轮 R3（2026-11-18）：管理技能弹层移动端 MobileSheet 化守卫——
// 原双端共用居中 Modal 在移动端形态错位 + 内置卡爆宽 2011px（CDP 实测，规格 §1.1 P2）。
// 判据：移动端走 MobileSheet 底部弹层、PC 保留居中 Modal；两端同接 useDockSkills 单一数据源。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

describe('管理技能弹层双形态（R3）', () => {
  it('移动端分支由 MobileSheet 承载（manageOpen && !isDesktopDock）', () => {
    expect(sfc).toMatch(/<MobileSheet\s+v-if="manageOpen && !isDesktopDock"/)
    expect(sfc).toContain('title="管理技能"')
  })

  it('PC 分支保留居中 Modal（manageOpen && isDesktopDock）', () => {
    expect(sfc).toMatch(/v-if="manageOpen && isDesktopDock"/)
    expect(sfc).toContain('w-[min(720px,92vw)]')
  })

  it('两端 SkillDiscoverPanel 同接 builtin-skills（dockSkills 单一事实源，禁双端信息不对称）', () => {
    const uses = sfc.match(/:builtin-skills="dockSkills\.map/g) ?? []
    expect(uses, '移动 MobileSheet 分支 + PC Modal 分支各 1 处').toHaveLength(2)
  })

  it('dockSkills 数据源来自 useDockSkills 组合式（禁第二份加载逻辑）', () => {
    expect(sfc).toContain("import { useDockSkills } from '@/composables/useDockSkills'")
    expect(sfc).toContain('const { dockSkills, loadDockSkills } = useDockSkills()')
    // 旧的内联加载逻辑必须已删（防两份实现漂移）
    expect(sfc).not.toContain('async function loadDockSkills()')
  })
})
