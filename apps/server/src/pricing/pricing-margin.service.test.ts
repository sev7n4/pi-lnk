// apps/server/src/pricing/pricing-margin.service.test.ts
import { describe, expect, it } from 'vitest'
import { phaseOf, resolveMargin, MARGIN_ORDER } from './pricing-margin.service'

const at = new Date('2026-06-01')

function row(o: Partial<{
  id: string; scope: string; scopeKey: string | null; profitBp: number; priceFloorBp: number; status: string
}>): {
  id: string; scope: string; scopeKey: string | null; profitBp: number; priceFloorBp: number
  effectiveFrom: Date | null; effectiveTo: Date | null; status: string
} {
  return {
    id: o.id ?? 'm',
    scope: o.scope ?? 'global',
    scopeKey: o.scopeKey ?? null,
    profitBp: o.profitBp ?? 1000,
    priceFloorBp: o.priceFloorBp ?? 500,
    effectiveFrom: null,
    effectiveTo: null,
    status: o.status ?? 'active',
  }
}

describe('phaseOf 唯一键', () => {
  it('global ⇒ launch', () => {
    expect(phaseOf('global', '*')).toBe('launch')
    expect(phaseOf('global', null)).toBe('launch')
  })
  it('非 global ⇒ scope:${scope}:${scopeKey}', () => {
    expect(phaseOf('model', 'x')).toBe('scope:model:x')
    expect(phaseOf('upstream', 'u1')).toBe('scope:upstream:u1')
    expect(phaseOf('model_spec', 'm1|spec1')).toBe('scope:model_spec:m1|spec1')
  })
})

describe('resolveMargin 六档优先级', () => {
  const subject = { capability: 'image', modelKey: 'm1', spec: 'spec1', provider: 'p1', upstream: 'u1' }

  it('全档齐备 ⇒ 最高优先级 model_spec 胜出', () => {
    const rows = [
      row({ id: 'g', scope: 'global', scopeKey: '*', profitBp: 1000 }),
      row({ id: 'mod', scope: 'modality', scopeKey: 'image', profitBp: 2000 }),
      row({ id: 'prov', scope: 'provider', scopeKey: 'p1', profitBp: 3000 }),
      row({ id: 'up', scope: 'upstream', scopeKey: 'u1', profitBp: 4000 }),
      row({ id: 'md', scope: 'model', scopeKey: 'm1', profitBp: 5000 }),
      row({ id: 'ms', scope: 'model_spec', scopeKey: 'm1|spec1', profitBp: 6000 }),
    ]
    const m = resolveMargin(subject, rows, at)
    expect(m).toEqual({ profitBp: 6000, priceFloorBp: 500, marginPolicyId: 'ms' })
  })

  it('逐档降级：去掉 model_spec ⇒ model 胜出，依次类推', () => {
    // 验证 ORDER 顺序严格生效
    const base = [
      row({ id: 'g', scope: 'global', scopeKey: '*', profitBp: 1000 }),
      row({ id: 'mod', scope: 'modality', scopeKey: 'image', profitBp: 2000 }),
      row({ id: 'prov', scope: 'provider', scopeKey: 'p1', profitBp: 3000 }),
      row({ id: 'up', scope: 'upstream', scopeKey: 'u1', profitBp: 4000 }),
      row({ id: 'md', scope: 'model', scopeKey: 'm1', profitBp: 5000 }),
    ]
    expect(resolveMargin(subject, base, at).profitBp).toBe(5000) // model
    const withoutModel = base.filter((r) => r.id !== 'md')
    expect(resolveMargin(subject, withoutModel, at).profitBp).toBe(4000) // upstream
    const withoutUp = withoutModel.filter((r) => r.id !== 'up')
    expect(resolveMargin(subject, withoutUp, at).profitBp).toBe(3000) // provider
    const withoutProv = withoutUp.filter((r) => r.id !== 'prov')
    expect(resolveMargin(subject, withoutProv, at).profitBp).toBe(2000) // modality
    const withoutMod = withoutProv.filter((r) => r.id !== 'mod')
    expect(resolveMargin(subject, withoutMod, at).profitBp).toBe(1000) // global
  })

  it('scopeKey 不匹配则跳过该档（即便 scope 命中）', () => {
    const rows = [
      row({ id: 'prov-wrong', scope: 'provider', scopeKey: 'p2', profitBp: 3000 }),
      row({ id: 'g', scope: 'global', scopeKey: '*', profitBp: 1000 }),
    ]
    expect(resolveMargin(subject, rows, at).profitBp).toBe(1000) // provider 的 scopeKey='p2'≠'p1' ⇒ 落 global
  })

  it('无命中 ⇒ global 缺省 1000/500', () => {
    expect(resolveMargin(subject, [], at)).toEqual({ profitBp: 1000, priceFloorBp: 500, marginPolicyId: '' })
  })

  it('非 active 档不参与解析', () => {
    const rows = [
      row({ id: 'md-off', scope: 'model', scopeKey: 'm1', profitBp: 5000, status: 'paused' }),
      row({ id: 'g', scope: 'global', scopeKey: '*', profitBp: 1000 }),
    ]
    expect(resolveMargin(subject, rows, at).profitBp).toBe(1000)
  })

  it('生效时间窗：future 行不命中，past 行命中', () => {
    const future = row({ id: 'md-f', scope: 'model', scopeKey: 'm1', profitBp: 5000, status: 'active' })
    future.effectiveFrom = new Date('2026-12-01')
    const past = row({ id: 'md-p', scope: 'model', scopeKey: 'm1', profitBp: 5000, status: 'active' })
    past.effectiveFrom = new Date('2026-01-01')
    past.effectiveTo = new Date('2026-03-01')
    expect(resolveMargin(subject, [future, row({ id: 'g', scope: 'global', scopeKey: '*', profitBp: 1000 })], at).profitBp).toBe(1000)
    expect(resolveMargin(subject, [past, row({ id: 'g', scope: 'global', scopeKey: '*', profitBp: 1000 })], at).profitBp).toBe(1000)
  })

  it('ORDER 常量导出顺序正确', () => {
    expect(MARGIN_ORDER).toEqual(['model_spec', 'model', 'upstream', 'provider', 'modality', 'global'])
  })
})
