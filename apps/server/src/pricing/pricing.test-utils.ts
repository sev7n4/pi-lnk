/**
 * 测试替身：quote 委托 legacyPriceOf ⇒ 各测试模块拿到「与常量一致」的定价，
 * 既有断言语义不变；同时覆盖「调用点确实走了 quote」的接线。
 * ruleVersion 固定 'test-constants' 以便与生产表版本区分。
 */
import { vi } from 'vitest'
import { legacyPriceOf, type PricingQuery, type PricingQuote } from './pricing.core'

export function createPricingMock() {
  return {
    onModuleInit: vi.fn(async () => {}),
    quote: vi.fn(async (q: PricingQuery): Promise<PricingQuote> => ({
      credits: legacyPriceOf(q),
      ruleVersion: 'test-constants',
    })),
  }
}
