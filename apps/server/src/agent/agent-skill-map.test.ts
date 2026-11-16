import { describe, expect, it } from 'vitest'
import { mapUiSkillId, resolveDockSkillTarget, withUserSkillNames } from './agent-skill-map'

describe('mapUiSkillId', () => {
  it('returns undefined for missing input', () => {
    expect(mapUiSkillId()).toBeUndefined()
    expect(mapUiSkillId('')).toBeUndefined()
  })

  it('maps product-visual to ecommerce-product-photo（pi 侧真实技能名）', () => {
    expect(mapUiSkillId('product-visual')).toBe('ecommerce-product-photo')
    expect(mapUiSkillId('ecommerce-product-photo')).toBe('ecommerce-product-photo')
  })

  it('未迁移的老技能不再映射（canvas → undefined，fail-soft）', () => {
    expect(mapUiSkillId('canvas')).toBeUndefined()
    expect(mapUiSkillId('enterprise-marketing-campaign')).toBeUndefined()
    expect(mapUiSkillId('ecommerce-product-visual')).toBeUndefined()
  })

  it('returns undefined for unmapped dock skills', () => {
    expect(mapUiSkillId('storyboard')).toBeUndefined()
    expect(mapUiSkillId('polish')).toBeUndefined()
    expect(mapUiSkillId('organize')).toBeUndefined()
  })

  it('returns undefined for unknown skill ids', () => {
    expect(mapUiSkillId('unknown-skill')).toBeUndefined()
  })
})

describe('resolveDockSkillTarget（M1-3 用户技能 pass-through）', () => {
  const userSkills = ['task-decomposition', 'storyboard']

  it('内置映射优先（product-visual → ecommerce-product-photo）', () => {
    expect(resolveDockSkillTarget('product-visual', userSkills)).toBe('ecommerce-product-photo')
  })

  it('内置无映射但命中用户技能名 → pass-through（用户装的同名内建技能走内置映射）', () => {
    expect(resolveDockSkillTarget('task-decomposition', userSkills)).toBe('task-decomposition')
    expect(resolveDockSkillTarget('storyboard', userSkills)).toBe('storyboard')
  })

  it('两者都不命中 → undefined（保持 P1 fail-soft；mapUiSkillId 语义不变）', () => {
    expect(resolveDockSkillTarget('unknown', userSkills)).toBeUndefined()
    expect(resolveDockSkillTarget(undefined, userSkills)).toBeUndefined()
  })
})

describe('resolveDockSkillTarget（内置技能可发现：运行时名 pass-through 第三参）', () => {
  const runtimeNames = [
    'drama-audio-design', 'drama-character-design', 'drama-motion-video', 'drama-qc-review',
    'drama-scene-worldview', 'drama-script-writing', 'drama-storyboard',
    'ecommerce-product-photo', 'html-craft', 'research-delegate', 'task-decomposition',
  ]

  it('内置映射优先于运行时名（product-visual 仍映射 ecommerce-product-photo）', () => {
    expect(resolveDockSkillTarget('product-visual', [], runtimeNames)).toBe('ecommerce-product-photo')
  })

  it('内置无映射但命中运行时名 → pass-through（drama-* 等内置技能可显式 forceSkills）', () => {
    expect(resolveDockSkillTarget('drama-script-writing', [], runtimeNames)).toBe('drama-script-writing')
    expect(resolveDockSkillTarget('html-craft', [], runtimeNames)).toBe('html-craft')
    expect(resolveDockSkillTarget('research-delegate', [], runtimeNames)).toBe('research-delegate')
  })

  it('用户名优先级不受影响（用户装的同名技能与运行时名行为一致）', () => {
    expect(resolveDockSkillTarget('task-decomposition', ['task-decomposition'], runtimeNames)).toBe('task-decomposition')
  })

  it('三处都不命中 → undefined（fail-soft 原文发送语义不变）', () => {
    expect(resolveDockSkillTarget('unknown', [], runtimeNames)).toBeUndefined()
    expect(resolveDockSkillTarget('drama-script-writing', [], [])).toBeUndefined()
    expect(resolveDockSkillTarget('drama-script-writing', [])).toBeUndefined()
    expect(resolveDockSkillTarget(undefined, [], runtimeNames)).toBeUndefined()
  })
})

describe('withUserSkillNames（M1-3 known 白名单并入用户技能）', () => {
  it('内置 known + 用户技能名合并去重', () => {
    const out = withUserSkillNames([{ name: 'ecommerce-product-photo' }], ['task-decomposition', 'ecommerce-product-photo'])
    expect(out.map((s) => s.name).sort()).toEqual(['ecommerce-product-photo', 'task-decomposition'])
  })

  it('用户技能为空 → 原样返回内置（P1 行为不变）', () => {
    const builtin = [{ name: 'a' }]
    expect(withUserSkillNames(builtin, [])).toEqual(builtin)
  })
})
