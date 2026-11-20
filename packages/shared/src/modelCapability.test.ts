import { describe, expect, it } from 'vitest'
import { supportsThinkingLevel } from './modelCapability'

/**
 * 红线（见 modelCapability.ts 注释）：判 true 会让 pi 给模型发 `reasoning_effort`，
 * 网关不支持就 400 —— 所以只收「确定支持」的系，拿不准一律 false。
 * 本文件同时锁住「前端可见性」与「pi 侧 model.reasoning」的同源关系。
 */
describe('supportsThinkingLevel（pi 链路 thinkingLevel 能力判定）', () => {
  it('空 / 空白 → false（不抛）', () => {
    expect(supportsThinkingLevel()).toBe(false)
    expect(supportsThinkingLevel('')).toBe(false)
    expect(supportsThinkingLevel('   ')).toBe(false)
    expect(supportsThinkingLevel(null)).toBe(false)
  })

  it('命中 reasoning 系：o1/o3/o4/gpt-5/deepseek-r1/deepseek-reasoner/deepseek-v4 系/deepseek-flash', () => {
    for (const ref of [
      'o1',
      'o3-mini',
      'o4-mini',
      'gpt-5',
      'deepseek-r1',
      'deepseek-reasoner',
      // 2026-11-21 放行（用户拍板）：DeepSeek V4 全系 + 官方 V4.1 Flash id。
      // 证据：老 studio 链路 buildDeepSeekThinkingFields 对 V4 系发
      // thinking:{type:"enabled"}+reasoning_effort（生产验证）；vendored pi-ai
      // openai-completions 内置 "deepseek" thinkingFormat 同构（baseUrl 含
      // deepseek.com 自动启用）。非 deepseek.com 网关裸 reasoning_effort 的
      // 个别 400 风险已接受（kill switch = 回滚本表）。
      'deepseek-v4',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-flash',
      'ch_1::gpt-5',
      'ch_1::deepseek-r1',
      'ch_1::deepseek-v4-flash',
    ]) {
      expect(supportsThinkingLevel(ref), ref).toBe(true)
    }
  })

  it('大小写不敏感', () => {
    expect(supportsThinkingLevel('GPT-5')).toBe(true)
    expect(supportsThinkingLevel('ch_1::DeepSeek-R1')).toBe(true)
    expect(supportsThinkingLevel('ch_1::DeepSeek-V4-Flash')).toBe(true)
  })

  it('非 reasoning 系一律 false：gemini / claude / 未知', () => {
    for (const ref of [
      'gemini-3.5-flash',
      'claude-sonnet-4',
      'some-unknown-model',
      'cmrrxageh000bql01xg1y6kjn::gemini-3.5-flash',
    ]) {
      expect(supportsThinkingLevel(ref), ref).toBe(false)
    }
  })

  it('ch_ 前缀按模型名判定（前缀不参与匹配）', () => {
    // 前缀里含 "gpt-5" 也不应误判：只看 :: 之后的 modelName
    expect(supportsThinkingLevel('ch_gpt-5::gemini-3.5-flash')).toBe(false)
    expect(supportsThinkingLevel('ch_whatever::gpt-5')).toBe(true)
    // 前缀不参与匹配，但 V4 模型名本身命中 ⇒ true（与上一条互补锁死两个方向）
    expect(supportsThinkingLevel('ch_gpt-5::deepseek-v4-pro')).toBe(true)
  })
})
