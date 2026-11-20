// 上下文窗口派生规则（模型选择卡配置页只读展示）：与服务端 resolveModelCapability 同源。
import { describe, expect, it } from 'vitest'
import { contextWindowLabel, resolveContextWindow } from './contextWindow'

describe('resolveContextWindow（与服务端能力解析同源）', () => {
  it('按模型名派生窗口 token 数', () => {
    expect(resolveContextWindow('ch_1::claude-sonnet-4')).toBe(200_000)
    expect(resolveContextWindow('ch_1::gemini-3.5-flash')).toBe(1_000_000)
    expect(resolveContextWindow('ch_1::gpt-5')).toBe(400_000)
  })

  it('未知 / 空值回落 128K（保守默认）', () => {
    expect(resolveContextWindow('ch_1::some-unknown-model')).toBe(128_000)
    expect(resolveContextWindow('   ')).toBe(128_000)
  })
})

describe('contextWindowLabel（只读展示串）', () => {
  it('4 档展示值', () => {
    expect(contextWindowLabel('ch_1::claude-sonnet-4')).toBe('200K')
    expect(contextWindowLabel('ch_1::gpt-5')).toBe('400K')
    expect(contextWindowLabel('ch_1::gemini-3.5-flash')).toBe('1M')
    expect(contextWindowLabel('ch_1::unknown')).toBe('128K')
  })
})
