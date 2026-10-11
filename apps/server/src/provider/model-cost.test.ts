import { resolveChannelModelCost } from './model-cost'

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
