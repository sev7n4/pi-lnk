/**
 * K-1：模型能力三层解析（spec §3.2）
 *
 * 关键红线：reasoning 判错会让 pi 给非 reasoning 模型发 `reasoning_effort` → 网关 400，
 * 所以第 3 层默认必须是 false，静态表只收"确定支持"的系。
 */
import { describe, expect, it } from 'vitest'
import { resolveModelCapability } from './model-capability'

describe('resolveModelCapability（K-1 能力三层解析）', () => {
  it('未知模型 → 保守默认（reasoning=false / 128k / 8k）', () => {
    expect(resolveModelCapability('ch_1::some-unknown-model')).toEqual({
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 8_192,
    })
  })

  it('空 ref → 保守默认（不抛）', () => {
    expect(resolveModelCapability('').reasoning).toBe(false)
    expect(resolveModelCapability('   ').contextWindow).toBe(128_000)
  })

  it('裸模型名（无 ch_x:: 前缀）同样解析', () => {
    expect(resolveModelCapability('deepseek-r1').reasoning).toBe(true)
  })

  it('reasoning 系命中：o1/o3/gpt-5/deepseek-r1/reasoner', () => {
    for (const ref of [
      'ch_1::o3-mini',
      'ch_1::o4-mini',
      'ch_1::gpt-5',
      'ch_1::deepseek-r1',
      'ch_1::deepseek-reasoner',
    ]) {
      expect(resolveModelCapability(ref).reasoning, ref).toBe(true)
    }
  })

  it('非 reasoning 系明确 false：deepseek-flash / deepseek-v4-pro / gemini / claude', () => {
    for (const ref of [
      'cmrrxageh000bql01xg1y6kjn::deepseek-flash',
      'cmrrxageh000bql01xg1y6kjn::deepseek-v4-pro',
      'ch_1::gemini-3.5-flash',
      'ch_1::claude-sonnet-4',
    ]) {
      expect(resolveModelCapability(ref).reasoning, ref).toBe(false)
    }
  })

  it('上下文窗按常见系放宽：claude 200k / gemini 1M / gpt-5 400k', () => {
    expect(resolveModelCapability('ch_1::claude-sonnet-4').contextWindow).toBe(200_000)
    expect(resolveModelCapability('ch_1::gemini-3.5-flash').contextWindow).toBe(1_000_000)
    expect(resolveModelCapability('ch_1::gpt-5').contextWindow).toBe(400_000)
  })

  it('maxTokens 恒为保守默认 8192', () => {
    expect(resolveModelCapability('ch_1::gpt-5').maxTokens).toBe(8_192)
  })
})
