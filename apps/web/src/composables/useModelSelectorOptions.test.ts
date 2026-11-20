import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/**
 * 2026-11-21 模型卡 R2（PR #967 后续）：倍率投影 + chip 仅模型名。
 * - multiplier 仅平台渠道文本模型有值（BYOK 不在平台价目表内 ⇒ 永不显示，禁造数）；
 * - currentLabel 去掉「（渠道名）」（composer 底部只显示模型名），渠道细节保留在 currentFullLabel。
 */

const preferencesMock = vi.fn()
const allChannelsMock = vi.fn()

vi.mock('./useProviderBootstrap', () => ({
  useProviderBootstrap: () => ({ preferences: preferencesMock(), allChannels: allChannelsMock() }),
}))

vi.mock('./useModelHealth', () => ({
  useModelHealth: () => ({ value: null }),
  availabilityOfModel: vi.fn(() => 'available'),
  healthDotOfModel: vi.fn(() => null),
}))

const { useModelSelectorOptions } = await import('./useModelSelectorOptions')
const { resetActivePricingCacheForTests } = await import('@/services/pricing-api')

function mockActivePricing(multipliers: Record<string, number>) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ code: 0, message: 'ok', data: { textTokenRatios: {}, multipliers } }),
  }))
}

describe('useModelSelectorOptions：倍率投影 + chip 文案', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    resetActivePricingCacheForTests()
    preferencesMock.mockReturnValue(
      ref({
        selectableTextModels: ['platform::step-3.5-flash', 'ch_byok::step-3.5-flash', 'platform::minimax-m2.7'],
        selectableImageModels: [],
        selectableVideoModels: [],
        selectableAudioModels: [],
      }),
    )
    allChannelsMock.mockReturnValue(
      ref([
        { id: 'platform', name: '平台' },
        { id: 'ch_byok', name: '我的渠道' },
      ]),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetActivePricingCacheForTests()
  })

  it('平台文本模型带 multiplier；同名 BYOK 渠道模型永不带（BYOK 不显示倍率）', async () => {
    vi.stubGlobal('fetch', mockActivePricing({ 'step-3.5-flash': 1.1 }))
    const opts = useModelSelectorOptions({ modelValue: () => 'platform::step-3.5-flash', type: () => 'text' })
    await vi.waitFor(() => {
      expect(opts.selectableOptions.value.find((m) => m.id === 'platform::step-3.5-flash')?.multiplier).toBe(1.1)
    })
    expect(opts.selectableOptions.value.find((m) => m.id === 'ch_byok::step-3.5-flash')?.multiplier).toBeUndefined()
    // 价目表没有的模型 → 键不出现（禁造数）
    expect(opts.selectableOptions.value.find((m) => m.id === 'platform::minimax-m2.7')?.multiplier).toBeUndefined()
  })

  it('非 text 模态不投影倍率（multipliers 数据源只有文本 token 行）', async () => {
    vi.stubGlobal('fetch', mockActivePricing({ 'step-3.5-flash': 1.1 }))
    const opts = useModelSelectorOptions({ modelValue: () => 'platform::step-3.5-flash', type: () => 'image' })
    await vi.waitFor(() => expect(opts.selectableOptions.value.length).toBe(0))
    expect(opts.selectableOptions.value.find((m) => m.id === 'platform::step-3.5-flash')).toBeUndefined()
  })

  it('currentLabel 只含模型名（去掉渠道）；currentFullLabel 保留渠道（tooltip 细节）', async () => {
    vi.stubGlobal('fetch', mockActivePricing({}))
    const opts = useModelSelectorOptions({ modelValue: () => 'platform::step-3.5-flash', type: () => 'text' })
    await vi.waitFor(() => expect(opts.current.value?.name).toBe('step-3.5-flash'))
    expect(opts.currentLabel.value).not.toContain('平台')
    expect(opts.currentLabel.value).not.toContain('（')
    expect(opts.currentFullLabel.value).toContain('平台')
  })

  it('倍率取数失败 → 全部 undefined（不抛错、不造数）', async () => {
    // 模块级缓存跨用例共享：用未在其它用例出现的模型名，确保断言只反映本用例的失败取数。
    preferencesMock.mockReturnValue(
      ref({
        selectableTextModels: ['platform::failure-probe'],
        selectableImageModels: [],
        selectableVideoModels: [],
        selectableAudioModels: [],
      }),
    )
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    const opts = useModelSelectorOptions({ modelValue: () => 'platform::failure-probe', type: () => 'text' })
    await vi.waitFor(() => expect(opts.current.value?.name).toBe('failure-probe'))
    expect(opts.selectableOptions.value.every((m) => m.multiplier === undefined)).toBe(true)
  })
})
