import { resolveChannelModelCost, resolveCostRateModelCost, withFxToCny } from './model-cost'

const MODELS_JSON = JSON.stringify([
  { name: 'deepseek-flash', capability: 'text' },
  { name: 'gpt-x', capability: 'text', pricing: { inputPerM: 0.5, outputPerM: 2 } },
  { name: 'claude-y', capability: 'text', pricing: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 } },
  { name: 'bad-z', capability: 'text', pricing: { inputPerM: -1 } },
  { name: 'empty-w', capability: 'text', pricing: {} },
])

describe('resolveChannelModelCost（P1 cost 接线读取面）', () => {
  it('命中 pricing → 四元组（缺省键补 0）', () => {
    expect(resolveChannelModelCost(MODELS_JSON, 'gpt-x')).toEqual({
      input: 0.5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('全键命中 → 原样四元组（大小写不敏感匹配模型名）', () => {
    expect(resolveChannelModelCost(MODELS_JSON, 'Claude-Y')).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    })
  })

  it('模型未命中 / 无 pricing 条目 → undefined', () => {
    expect(resolveChannelModelCost(MODELS_JSON, 'deepseek-flash')).toBeUndefined()
    expect(resolveChannelModelCost(MODELS_JSON, 'nope')).toBeUndefined()
  })

  it('pricing 畸形（负数）→ undefined（宁可少算不错算）', () => {
    expect(resolveChannelModelCost(MODELS_JSON, 'bad-z')).toBeUndefined()
  })

  it('pricing 空对象 → undefined（视为未声明，不产出全零对象）', () => {
    expect(resolveChannelModelCost(MODELS_JSON, 'empty-w')).toBeUndefined()
  })

  it('JSON 畸形 / 非数组 / 空入参 → undefined（绝不阻断会话创建）', () => {
    expect(resolveChannelModelCost('not json', 'gpt-x')).toBeUndefined()
    expect(resolveChannelModelCost('{"a":1}', 'gpt-x')).toBeUndefined()
    expect(resolveChannelModelCost(null, 'gpt-x')).toBeUndefined()
    expect(resolveChannelModelCost(MODELS_JSON, '')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// P2a（spec 2026-11-15-p2-session-cost-cny-migration-design §4.1/§4.4）：
// CostRate（定价中心，CNY 权威源）→ 会话成本读取面 + 出口统一币种折算。
// ---------------------------------------------------------------------------

type CrRow = {
  channel: string
  modelKey: string
  spec: string
  unit: string
  unitQuantity: number
  costYuan: number
  provisional: boolean
  effectiveFrom: Date | null
  effectiveTo: Date | null
}

const crRow = (over: Partial<CrRow> = {}): CrRow => ({
  channel: 'platform',
  modelKey: 'step-3.5-flash',
  spec: 'per_1m_tokens_in',
  unit: 'per_1m_tokens',
  unitQuantity: 1e6,
  costYuan: 0.7,
  provisional: false,
  effectiveFrom: null,
  effectiveTo: null,
  ...over,
})

describe('resolveCostRateModelCost（P2a 会话成本读取面，CNY）', () => {
  it('三档命中 → CNY 四元组（cacheWrite=0，核对点 1）', () => {
    expect(
      resolveCostRateModelCost(
        [
          crRow({ spec: 'per_1m_tokens_in', costYuan: 0.7 }),
          crRow({ spec: 'per_1m_tokens_out', costYuan: 2.1 }),
          crRow({ spec: 'per_1m_tokens_cache', costYuan: 0.14 }),
        ],
        'step-3.5-flash',
        new Date(),
      ),
    ).toEqual({ input: 0.7, output: 2.1, cacheRead: 0.14, cacheWrite: 0 })
  })

  it('provisional=true → 视为缺档（裁决 2；agnes-2.0 生产实态回归锚）', () => {
    const rows = [
      crRow({ modelKey: 'agnes-2.0-flash', provisional: true }),
      crRow({ modelKey: 'agnes-2.0-flash', spec: 'per_1m_tokens_out', provisional: true }),
      crRow({ modelKey: 'agnes-2.0-flash', spec: 'per_1m_tokens_cache', provisional: true }),
    ]
    expect(resolveCostRateModelCost(rows, 'agnes-2.0-flash', new Date())).toBeUndefined()
  })

  it('缺任一必需档（in/out）→ undefined（宁可少算不错算）', () => {
    const rows = [
      crRow({ spec: 'per_1m_tokens_in', costYuan: 0.7 }),
      crRow({ spec: 'per_1m_tokens_cache', costYuan: 0.14 }),
    ]
    expect(resolveCostRateModelCost(rows, 'step-3.5-flash', new Date())).toBeUndefined()
  })

  it('cache 档缺失是受支持形态 → cacheRead=0（与 quoteTextTokens 灰度缺 cache 行同语义）', () => {
    const rows = [crRow({ spec: 'per_1m_tokens_in' }), crRow({ spec: 'per_1m_tokens_out', costYuan: 2.1 })]
    expect(resolveCostRateModelCost(rows, 'step-3.5-flash', new Date())).toEqual({
      input: 0.7,
      output: 2.1,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('单档畸形 costYuan（负数/非有限）→ 整组 undefined', () => {
    const rows = [
      crRow({ spec: 'per_1m_tokens_in' }),
      crRow({ spec: 'per_1m_tokens_out', costYuan: -1 }),
    ]
    expect(resolveCostRateModelCost(rows, 'step-3.5-flash', new Date())).toBeUndefined()
    const rows2 = [
      crRow({ spec: 'per_1m_tokens_in', costYuan: Number.NaN }),
      crRow({ spec: 'per_1m_tokens_out' }),
    ]
    expect(resolveCostRateModelCost(rows2, 'step-3.5-flash', new Date())).toBeUndefined()
  })

  it('channel 限定 platform：同 modelKey 其它渠道行不参与（§2.3 BYOK 边界）', () => {
    const rows = [
      crRow({ channel: 'byok', spec: 'per_1m_tokens_in' }),
      crRow({ channel: 'byok', spec: 'per_1m_tokens_out' }),
    ]
    expect(resolveCostRateModelCost(rows, 'step-3.5-flash', new Date())).toBeUndefined()
  })

  it('有效期窗口外（effectiveTo <= at）→ 视为缺档；未生效（effectiveFrom > at）同理', () => {
    const at = new Date('2026-11-16T00:00:00Z')
    const expired = [
      crRow({ spec: 'per_1m_tokens_in', effectiveTo: new Date('2026-11-15T00:00:00Z') }),
      crRow({ spec: 'per_1m_tokens_out' }),
    ]
    expect(resolveCostRateModelCost(expired, 'step-3.5-flash', at)).toBeUndefined()
    const future = [
      crRow({ spec: 'per_1m_tokens_in', effectiveFrom: new Date('2026-11-17T00:00:00Z') }),
      crRow({ spec: 'per_1m_tokens_out' }),
    ]
    expect(resolveCostRateModelCost(future, 'step-3.5-flash', at)).toBeUndefined()
  })

  it('unitQuantity 非 1e6 时按「元/百万 token」归一（costYuan * 1e6 / unitQuantity）', () => {
    const rows = [
      crRow({ spec: 'per_1m_tokens_in', unitQuantity: 5e5, costYuan: 0.35 }),
      crRow({ spec: 'per_1m_tokens_out' }),
    ]
    expect(resolveCostRateModelCost(rows, 'step-3.5-flash', new Date())).toMatchObject({ input: 0.7 })
  })

  it('非 per_1m_tokens 行（如 per_request）不参与文本 token 归组', () => {
    const rows = [
      crRow({ spec: 'per_1m_tokens_in', unit: 'per_request' }),
      crRow({ spec: 'per_1m_tokens_out' }),
    ]
    expect(resolveCostRateModelCost(rows, 'step-3.5-flash', new Date())).toBeUndefined()
  })

  it('modelKey 大小写不敏感匹配（与 resolveChannelModelCost 同纪律）', () => {
    const rows = [crRow({ modelKey: 'Step-3.5-Flash' }), crRow({ modelKey: 'STEP-3.5-FLASH', spec: 'per_1m_tokens_out' })]
    expect(resolveCostRateModelCost(rows, 'step-3.5-flash', new Date())).toEqual({
      input: 0.7,
      output: 0.7,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})

describe('withFxToCny（出口统一币种，核对点 5）', () => {
  it('四元组逐键 ×FX（0.27 USD/百万 × 7.15 = 1.9305 CNY/百万）', () => {
    const out = withFxToCny({ input: 0.27, output: 1.1, cacheRead: 0, cacheWrite: 0 }, 7.15)
    expect(out.input).toBeCloseTo(1.9305, 12)
    expect(out.output).toBeCloseTo(7.865, 12)
    expect(out.cacheRead).toBe(0)
    expect(out.cacheWrite).toBe(0)
  })
})
