import { describe, expect, it } from 'vitest'
import { collapseToolCalls } from './collapseToolCalls'

describe('collapseToolCalls（P1#3 工具卡合并）', () => {
  it('≥3 次连续同名调用合并为一张计数卡', () => {
    const calls = [
      { name: 'get_node', argsSummary: 'A' },
      { name: 'get_node', argsSummary: 'B' },
      { name: 'get_node', argsSummary: 'C' },
      { name: 'upsert_media_node', argsSummary: 'D' },
    ]
    const out = collapseToolCalls(calls)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ name: 'get_node', count: 3 })
    expect(out[0].argsSummary).toBeUndefined() // 合并卡不保留单次 args
    expect(out[1]).toMatchObject({ name: 'upsert_media_node', count: 1, argsSummary: 'D' })
  })

  it('2 次连续同名不合并（低频调用保持独立）', () => {
    const out = collapseToolCalls([{ name: 'undo' }, { name: 'undo' }])
    expect(out).toHaveLength(2)
    expect(out.every((c) => c.count === 1)).toBe(true)
  })

  it('同名不连续的调用各自独立', () => {
    const out = collapseToolCalls([
      { name: 'get_node' },
      { name: 'upsert_media_node' },
      { name: 'get_node' },
    ])
    expect(out).toHaveLength(3)
  })

  it('空列表返回空', () => {
    expect(collapseToolCalls([])).toEqual([])
  })
})
