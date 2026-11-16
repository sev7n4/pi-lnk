// 文件：apps/server/src/skills/skills-resources.test.ts
// M1-3 发起方接线纯函数单测（assembleSkillResources）。
// 判据：
//  - A2 前置：用户已启用技能逐字组装为上游 Skill[]（content = body 原文不 trim）。
//  - 计划 §2 决策 1：虚拟 filePath / disableModelInvocation 透传 / ≤12 裁剪 / 同名按 name 去重（后者胜出）。
//  - §7.2：跳过 disabled 行（enabled=false 不进 index）；description 用 summary||displayName 保证非空。
//  - 契约对齐 runtime parseIncomingResources：name/description/content 必填非空；无 undefined 字段。
import { describe, expect, it } from 'vitest'
import { assembleSkillResources, MAX_ASSEMBLED_SKILLS, type SkillResourceRow } from './skills-resources.js'

const row = (over: Partial<SkillResourceRow> = {}): SkillResourceRow => ({
  skill: 'task-decomposition',
  displayName: '任务分解',
  summary: '把复杂需求拆成可执行步骤',
  body: '# 任务分解\n逐字正文，含前后空格  \n',
  disableModelInvocation: false,
  enabled: true,
  installedAt: new Date('2026-11-16T10:00:00Z'),
  ...over,
})

describe('assembleSkillResources — M1-3 Nest 发起方组装', () => {
  it('已启用技能逐字组装：content=body 原文、虚拟 filePath、description 取 summary', () => {
    const out = assembleSkillResources([row()])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      name: 'task-decomposition',
      description: '把复杂需求拆成可执行步骤',
      content: '# 任务分解\n逐字正文，含前后空格  \n',
      filePath: '<virtual>/task-decomposition/SKILL.md',
      disableModelInvocation: false,
    })
  })

  it('summary 空时 description 回退 displayName，保证 runtime 非空校验通过', () => {
    const out = assembleSkillResources([row({ summary: '' })])
    expect(out[0].description).toBe('任务分解')
  })

  it('跳过 enabled=false 的行（关闭态不进 index）', () => {
    const out = assembleSkillResources([row({ skill: 'off', enabled: false }), row({ skill: 'on', enabled: true })])
    expect(out.map((s) => s.name)).toEqual(['on'])
  })

  it('同名按 name 去重，后者（installedAt 更新）胜出', () => {
    const old = row({ installedAt: new Date('2026-11-15T10:00:00Z'), body: 'OLD' })
    const fresh = row({ installedAt: new Date('2026-11-16T10:00:00Z'), body: 'FRESH' })
    const out = assembleSkillResources([old, fresh])
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('FRESH')
  })

  it(`最多裁剪到 ${MAX_ASSEMBLED_SKILLS} 条（按 installedAt 降序取前 N）`, () => {
    const rows = Array.from({ length: MAX_ASSEMBLED_SKILLS + 5 }, (_, i) =>
      row({ skill: `s-${i}`, installedAt: new Date(Date.UTC(2026, 0, 1 + i)) }),
    )
    const out = assembleSkillResources(rows)
    expect(out).toHaveLength(MAX_ASSEMBLED_SKILLS)
    expect(out[0].name).toBe(`s-${MAX_ASSEMBLED_SKILLS + 4}`)
    expect(out[out.length - 1].name).toBe('s-5')
  })

  it('disableModelInvocation=true 逐字透传（上游原义：排除出隐式 index 仍可显式调用）', () => {
    const out = assembleSkillResources([row({ disableModelInvocation: true })])
    expect(out[0].disableModelInvocation).toBe(true)
  })

  it('输出对象不含 undefined 字段（对齐 runtime 落盘/deepEqual 口径）', () => {
    const out = assembleSkillResources([row()])
    for (const s of out) {
      for (const [k, v] of Object.entries(s)) expect(v, `字段 ${k} 不应为 undefined`).not.toBeUndefined()
    }
  })
})
