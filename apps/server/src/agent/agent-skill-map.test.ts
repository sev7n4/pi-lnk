import { describe, expect, it } from 'vitest'
import { mapUiSkillId } from './agent-skill-map'

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
