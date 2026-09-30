import { describe, expect, it } from 'vitest'
import { stripPlanMarkers } from './planMarkers'

describe('stripPlanMarkers（P1#5 plan 内联标记）', () => {
  it('剥离 plan 标记并解析条目', () => {
    const r = stripPlanMarkers('开工\n⟦plan⟧[{"n":1,"title":"起稿"},{"n":2,"title":"配图"}]\n开始')
    expect(r.text).toBe('开工\n\n开始')
    expect(r.plan).toEqual([
      { n: 1, title: '起稿' },
      { n: 2, title: '配图' },
    ])
    expect(r.doneN).toBeUndefined()
  })

  it('剥离 task-done 标记', () => {
    const r = stripPlanMarkers('完成\n⟦task-done⟧1\n继续')
    expect(r.text).toBe('完成\n\n继续')
    expect(r.doneN).toBe(1)
  })

  it('无标记时文本字节级等价（Review Focus #1）', () => {
    const src = '普通回复，没有任何标记 ✓\n多行\n内容'
    expect(stripPlanMarkers(src).text).toBe(src)
  })

  it('畸形 JSON：标记仍剥离、plan 为 undefined、不抛错（Review Focus #4）', () => {
    const r = stripPlanMarkers('a\n⟦plan⟧{oops\nb')
    expect(r.text).toBe('a\n\nb')
    expect(r.plan).toBeUndefined()
  })

  it('形状不对的 plan JSON（非 {n,title} 数组）：剥离但不派生', () => {
    const r = stripPlanMarkers('x\n⟦plan⟧["just","strings"]\ny')
    expect(r.text).toBe('x\n\ny')
    expect(r.plan).toBeUndefined()
  })
})
