import { describe, expect, it } from 'vitest'
import { edgeIdOf, validateEdgeAdditions, wouldCreateCycle } from './graph'

const nodes = (ids: string[]) => ids.map((id) => ({ id }))

describe('wouldCreateCycle', () => {
  it('自环 source===target 即成环', () => {
    expect(wouldCreateCycle([], 'a', 'a')).toBe(true)
  })
  it('直接 2-环：a->b 存在时 b->a 成环', () => {
    expect(wouldCreateCycle([{ source: 'a', target: 'b' }], 'b', 'a')).toBe(true)
  })
  it('长环 a->b->c 存在时 c->a 成环', () => {
    expect(
      wouldCreateCycle(
        [
          { source: 'a', target: 'b' },
          { source: 'b', target: 'c' },
        ],
        'c',
        'a',
      ),
    ).toBe(true)
  })
  it('无回边不成环（a->b 后加 b->c）', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' },
    ]
    expect(wouldCreateCycle(edges, 'b', 'c')).toBe(false)
  })
})

describe('validateEdgeAdditions', () => {
  const ns = nodes(['a', 'b', 'c', 'd'])
  it('悬空端点 rejected(missing-node)', () => {
    const r = validateEdgeAdditions(ns, [], [{ source: 'a', target: 'ghost' }])
    expect(r.valid).toHaveLength(0)
    expect(r.rejected[0].reason).toBe('missing-node')
  })
  it('自环 rejected(self-loop)', () => {
    const r = validateEdgeAdditions(ns, [], [{ source: 'a', target: 'a' }])
    expect(r.rejected[0].reason).toBe('self-loop')
  })
  it('已存在同向对 rejected(duplicate)（幂等跳过语义，不报错）', () => {
    const r = validateEdgeAdditions(
      ns,
      [{ source: 'a', target: 'b' }],
      [{ source: 'a', target: 'b' }],
    )
    expect(r.valid).toHaveLength(0)
    expect(r.rejected[0].reason).toBe('duplicate')
  })
  it('成环 rejected(cycle)，合法边产出 id=e-source-target', () => {
    const r = validateEdgeAdditions(
      ns,
      [{ source: 'a', target: 'b' }],
      [
        { source: 'c', target: 'd' },
        { source: 'b', target: 'a' },
      ],
    )
    expect(r.valid).toEqual([{ id: 'e-c-d', source: 'c', target: 'd' }])
    expect(r.rejected).toEqual([{ edge: { source: 'b', target: 'a' }, reason: 'cycle' }])
  })
  it('批内互相成环（a->b 后 b->a）第二条约 cycle', () => {
    const r = validateEdgeAdditions(ns, [], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ])
    expect(r.valid).toHaveLength(1)
    expect(r.rejected[0].reason).toBe('cycle')
  })
  it('混合批部分硬非法 ⇒ 整批不落 valid 之外的原语语义：合法者进 valid、非法者进 rejected（由调用方 fail-closed）', () => {
    const r = validateEdgeAdditions(ns, [], [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'ghost' },
    ])
    expect(r.valid).toEqual([{ id: 'e-a-b', source: 'a', target: 'b' }])
    expect(r.rejected[0].reason).toBe('missing-node')
  })
  it('确定性：同输入两次调用结果 deep-equal', () => {
    const run = () =>
      validateEdgeAdditions(
        nodes(['a', 'b', 'c']),
        [{ source: 'a', target: 'b' }],
        [{ source: 'b', target: 'c' }],
      )
    expect(run()).toEqual(run())
  })
})

describe('edgeIdOf', () => {
  it('沿用 e-source-target 规则', () => {
    expect(edgeIdOf('a', 'b')).toBe('e-a-b')
  })
})
