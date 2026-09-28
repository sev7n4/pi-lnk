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

  it('命中 reasoning 系：o1/o3/o4/gpt-5/deepseek-r1/deepseek-reasoner', () => {
    for (const ref of [
      'o1',
      'o3-mini',
      'o4-mini',
      'gpt-5',
      'deepseek-r1',
      'deepseek-reasoner',
      'ch_1::gpt-5',
      'ch_1::deepseek-r1',
    ]) {
      expect(supportsThinkingLevel(ref), ref).toBe(true)
    }
  })

  it('大小写不敏感', () => {
    expect(supportsThinkingLevel('GPT-5')).toBe(true)
    expect(supportsThinkingLevel('ch_1::DeepSeek-R1')).toBe(true)
  })

  it('非 reasoning 系一律 false：deepseek-v4 / deepseek-flash / gemini / claude / 未知', () => {
    for (const ref of [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-flash',
      'gemini-3.5-flash',
      'claude-sonnet-4',
      'some-unknown-model',
      'ch_1::deepseek-v4-pro',
      'cmrrxageh000bql01xg1y6kjn::deepseek-v4-pro',
    ]) {
      expect(supportsThinkingLevel(ref), ref).toBe(false)
    }
  })

  it('ch_ 前缀按模型名判定（前缀不参与匹配）', () => {
    // 前缀里含 "gpt-5" 也不应误判：只看 :: 之后的 modelName
    expect(supportsThinkingLevel('ch_gpt-5::deepseek-v4-pro')).toBe(false)
    expect(supportsThinkingLevel('ch_whatever::gpt-5')).toBe(true)
  })
})
