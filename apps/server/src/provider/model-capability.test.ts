/**
 * K-1：模型能力三层解析（spec §3.2）
 *
 * 关键红线：reasoning 判错会让 pi 给非 reasoning 模型发 `reasoning_effort` → 网关 400，
 * 所以第 3 层默认必须是 false，静态表只收"确定支持"的系。
 */
import { describe, expect, it } from 'vitest'
import { resolveModelCapability, resolveVisionInputSupport } from './model-capability'

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

// ↓ 2026-10-03 识图失效事故回归锁（生产实测）
// 事故链：Nest 说"支持视觉" → 走多模态直通 → pi-runtime 的 model.input 却缺 "image"
// → vendor transform-messages 把图换成 "(image omitted: ...)" → 上游 200、模型说看不见。
// 两侧判据必须同源，且都不得靠正则猜。
describe('resolveVisionInputSupport（视觉「输入」能力，与输出模态严格分离）', () => {
  it('显式声明 wins（唯一权威）：capability=vision → supported', () => {
    expect(
      resolveVisionInputSupport('ch_1::some-obscure-model', { declared: 'vision' }),
    ).toBe('supported')
  })

  it('显式声明 text / video / audio / image(生成器) 均不支持视觉输入', () => {
    // 'image' 是输出模态（这模型是画图生成器），与"能否看图"是两件事
    for (const declared of ['text', 'video', 'audio', 'image'] as const) {
      expect(resolveVisionInputSupport('ch_1::m', { declared }), declared).toBe('unsupported')
    }
  })

  it('无声明 → unknown，**绝不** fallback 成 true（不猜 = 不让上游 400）', () => {
    expect(resolveVisionInputSupport('ch_1::agnes-2.5-flash', {})).toBe('unknown')
    expect(resolveVisionInputSupport('ch_1::gpt-4o', {})).toBe('unknown')
  })

  it('探针实测结果优先于声明（实测压倒声明：渠道标签会错）', () => {
    expect(
      resolveVisionInputSupport('ch_1::agnes-2.5-flash', { probed: true, declared: 'text' }),
    ).toBe('supported')
    expect(
      resolveVisionInputSupport('ch_1::agnes-2.5-flash', { probed: false, declared: 'vision' }),
    ).toBe('unsupported')
  })

  it('空 ref → unknown（不抛，不猜）', () => {
    expect(resolveVisionInputSupport('', {})).toBe('unknown')
    expect(resolveVisionInputSupport('   ', { declared: 'vision' })).toBe('unknown')
  })

  it('resolveModelCapability 不再声称能判视觉（避免两个真相源）', () => {
    // 旧实现把视觉混在 ModelCapability 里，导致 Nest 与 pi-runtime 各判一次
    expect(Object.keys(resolveModelCapability('ch_1::gpt-4o')).sort()).toEqual([
      'contextWindow',
      'maxTokens',
      'reasoning',
    ])
  })
})
