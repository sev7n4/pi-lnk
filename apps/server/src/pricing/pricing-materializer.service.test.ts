// apps/server/src/pricing/pricing-materializer.service.test.ts
import { describe, expect, it } from 'vitest'
import { creditsOf, ratioOf } from './pricing-materializer.service'
import { computeCreditsFromCost, checkCostFloor } from './pricing.core'

describe('materialization formulas', () => {
  it('AC6：profitBp=1000 与现网 computeCreditsFromCost(cost,11000) 逐值相等', () => {
    for (const c of [0.009, 0.3, 0.572, 2.86, 4.65, 8.58, 20]) {
      expect(creditsOf(c, 1000)).toBe(computeCreditsFromCost(c, 11000))
    }
  })
  it('AC6：反比率 r 与现网 floor(1e6/(cost×110)) 逐值相等', () => {
    for (const c of [0.14, 0.7, 2.1, 8.1, 20]) {
      expect(ratioOf(c, 1000)).toBe(Math.floor(1e6 / (c * 110)))
    }
  })
  it('AC9：文本反比率不得误用 costYuanPerRequest（1e6 倍错价负例）', () => {
    expect(ratioOf(0.7, 1000)).toBe(Math.floor(1e6 / (0.7 * 110)))
    expect(ratioOf(0.7, 1000)).not.toBe(creditsOf(0.7, 1000))
  })
  it('AC14：地板按归一后成本，图片 3 张下限 95 而非 32', () => {
    expect(checkCostFloor({ matchKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart', credits: 40, costRateId: 'r1' }, 0.9)).toMatchObject({ kind: 'min', limit: 95 })
    expect(checkCostFloor({ matchKey: 'image|seedream-5.0-pro|1K:3|volcengine|apimart', credits: 100, costRateId: 'r1' }, 0.9)).toBeNull()
  })
  it('AC14：反比率上限按 priceFloorBp(500) 而非 profitBp(1000)', () => {
    const cost = 0.7
    const floorLimit = Math.floor(1e8 / (cost * 10500))
    expect(floorLimit).toBe(Math.floor(1e6 / (cost * 105)))
    expect(checkCostFloor({ matchKey: 'text:step-3.5-flash:in', credits: floorLimit + 1, costRateId: 'r1' }, cost)).toMatchObject({ kind: 'max', limit: floorLimit })
  })
})
