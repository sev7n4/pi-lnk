// apps/server/src/pricing/pricing-subject.service.test.ts
import { describe, expect, it } from 'vitest'
import { subjectKeyOf, resolveUpstream, buildSubjectRows } from './pricing-subject.service'
import { UPSTREAM_ROUTE_SEEDS } from '@lnkpi/shared'

describe('PricingSubject rebuild source of truth', () => {
  it('两路枚举：档位行 + 23 条 token 反比率行都在', () => {
    const rows = buildSubjectRows(
      [
        { modelKey: 'step-3.5-flash', modality: 'text', providerBinding: 'gateway-openai-compat' },
        { modelKey: 'seedream-5.0-pro', modality: 'image', providerBinding: 'gateway-openai-compat' },
      ],
      UPSTREAM_ROUTE_SEEDS,
    )
    expect(rows.some((r) => r.spec === 'in' && r.modelKey === 'step-3.5-flash')).toBe(true)
    expect(rows.some((r) => r.spec === 'cache' && r.modelKey === 'step-3.5-flash')).toBe(true)
    expect(rows.some((r) => r.capability === 'image' && r.spec === '1K:1')).toBe(true)
  })

  it('U6：成本侧 seedance-2.0-fast 归到 default 家族，不产生新 upstream', () => {
    expect(resolveUpstream('seedance-2.0-fast', 'video', UPSTREAM_ROUTE_SEEDS)).toBe('agnes_hub')
    expect(resolveUpstream('minimax-h3', 'video', UPSTREAM_ROUTE_SEEDS)).toBe('minimax')
    expect(resolveUpstream('cogvideox-flash', 'video', UPSTREAM_ROUTE_SEEDS)).toBe('zhipu')
  })

  it('subjectKey 归一剥渠道前缀、小写、五段', () => {
    expect(subjectKeyOf({ capability: 'text', modelKey: 'platform::Agnes-2.5-Flash', spec: 'in', provider: 'agnes', upstream: 'agnes_hub' }))
      .toBe('text|agnes-2.5-flash|in|agnes|agnes_hub')
  })

  it('BYOK 不产生主体', () => {
    const rows = buildSubjectRows(
      [{ modelKey: 'byok-model', modality: 'text', providerBinding: 'gateway-openai-compat', byok: true }],
      UPSTREAM_ROUTE_SEEDS,
    )
    expect(rows.length).toBe(0)
  })
})
