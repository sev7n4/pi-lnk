import { describe, expect, it } from 'vitest'
import {
  defaultModelKey,
  getModelEntry,
  listModels,
  resolveModelKey,
  STUDIO_MODEL_CATALOG,
} from './studioModelCatalog'

/**
 * S0-1 幽灵模型下架回归锁（2026-10-09）。
 *
 * ⛔ 事故背景：`deepseek-v4` 等 3 个文本模型在 `STUDIO_MODEL_CATALOG` 里，
 * 但 agnes hub `/v1/models` 无对应渠道 ⇒ 用户选中即 503 model_not_found
 * （取证见 docs/superpowers/specs/2026-10-09-model-platform-hardening-design.md §2.4）。
 *
 * 下架方式：从目录删条目（原位置留注释块），DB 镜像与用户快照由既有
 * `model-catalog-sync`（#306）闭环 —— 服务端侧见 model-catalog-sync.test.ts。
 */
describe('S0-1 幽灵模型下架', () => {
  const GHOST_KEYS = ['deepseek-v4', 'gemini-3.1-flash', 'gpt-5.5']

  it('A1：文本模型恰剩 2 个（2.0-flash + 2.5-flash 接位），目录总数 26', () => {
    const text = listModels('text')
    expect(text.map((m) => m.modelKey)).toEqual(['agnes-2.0-flash', 'agnes-2.5-flash'])
    expect(STUDIO_MODEL_CATALOG).toHaveLength(26)
  })

  it('A1：3 个幽灵 key 均已不在目录（双向查不到）', () => {
    for (const key of GHOST_KEYS) {
      expect(getModelEntry(key), `幽灵 key 仍在目录：${key}`).toBeUndefined()
    }
  })

  it('A4：resolveModelKey 对幽灵 key 走既有确定性兜底，不命中、不静默采用', () => {
    // ⚠️ resolveModelKey 对未知 key 的既有行为是「回退默认模型 + fallback 标志」，
    // 不是 throw（studioModelCatalog.test.ts 已锁死该行为，调用方必须检查
    // `fallback` 并拒绝，见 normalizeModelRef 的 SSOT 注释）。本测试锁的是：
    // 下架后幽灵 key 不再命中目录 ⇒ 引用幽灵模型的存量画布节点不崩，
    // 且解析结果确定性地落到默认文本模型，绝无「选 A 生成幽灵模型」的静默路径。
    for (const key of GHOST_KEYS) {
      const r = resolveModelKey('text', key)
      expect(r.fallback, `${key} 不应命中目录`).toBe(true)
      expect(r.modelKey).toBe(defaultModelKey('text'))
      expect(r.entry.modelKey).toBe(defaultModelKey('text'))
    }
  })
})
