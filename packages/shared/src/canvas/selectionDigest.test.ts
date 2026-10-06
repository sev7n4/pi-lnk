import { describe, expect, it } from 'vitest'
import { buildSelectionDigest, type SelectionDigestNode } from './selectionDigest'

const N = (id: string, over: Partial<SelectionDigestNode> = {}): SelectionDigestNode => ({
  type: 'image',
  title: id,
  x: 0,
  y: 0,
  ...over,
})
const mapOf = (m: Record<string, SelectionDigestNode>) => (id: string) => m[id]
const TAIL = '用户说「这个 / 这几个」时指的就是上面这些；要看细节调 get_node。'

describe('buildSelectionDigest', () => {
  it('空集返回 null（调用方整块不输出）', () => {
    expect(buildSelectionDigest({ nodeIds: [], lookup: () => undefined })).toBeNull()
  })

  it('全部 id 无效返回 null，不注入半截', () => {
    expect(buildSelectionDigest({ nodeIds: ['x', 'y'], lookup: () => undefined })).toBeNull()
  })

  it('单选：含 id/type/标题，标注单选', () => {
    const out = buildSelectionDigest({
      nodeIds: ['a'],
      lookup: mapOf({ a: N('a', { title: '小柚定妆照' }) }),
    })!
    expect(out).toBe(
      ['【用户当前选中】1 个节点（单选）', '- a · image · 小柚定妆照', TAIL].join('\n'),
    )
  })

  it('按画布位置排序（y → x），与传入顺序无关', () => {
    const m = { a: N('a', { y: 2, x: 0 }), b: N('b', { y: 1, x: 9 }), c: N('c', { y: 1, x: 1 }) }
    const out = buildSelectionDigest({ nodeIds: ['a', 'b', 'c'], lookup: mapOf(m) })!
    expect(out.indexOf('- c')).toBeLessThan(out.indexOf('- b'))
    expect(out.indexOf('- b')).toBeLessThan(out.indexOf('- a'))
    expect(out.startsWith('【用户当前选中】3 个节点（框选）')).toBe(true)
  })

  it('同位置时按 id 稳定排序（byte-stable）', () => {
    const m = { b: N('b'), a: N('a'), c: N('c') }
    const runs = [0, 1, 2].map(() =>
      buildSelectionDigest({ nodeIds: ['c', 'b', 'a'], lookup: mapOf(m) }),
    )
    expect(runs[1]).toBe(runs[0])
    expect(runs[2]).toBe(runs[0])
    expect(runs[0]!.indexOf('- a')).toBeLessThan(runs[0]!.indexOf('- b'))
  })

  it('超过 limit：列前 8 + 「另 N 个」且总数必写', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`)
    const m = Object.fromEntries(ids.map((id, i) => [id, N(id, { y: i })]))
    const out = buildSelectionDigest({ nodeIds: ids, lookup: mapOf(m) })!
    expect(out.startsWith('【用户当前选中】9 个节点（框选）')).toBe(true)
    expect(out).toContain('- （另 1 个：n8）')
  })

  it('无效 id 被剔除、总数按剔除后计', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`)
    const m = Object.fromEntries(ids.slice(0, 7).map((id, i) => [id, N(id, { y: i })]))
    const out = buildSelectionDigest({ nodeIds: ids, lookup: mapOf(m) })!
    expect(out.startsWith('【用户当前选中】7 个节点（框选）')).toBe(true)
    expect(out).not.toContain('另')
  })

  it('标题里的换行被压平（否则破坏块的行结构）', () => {
    const out = buildSelectionDigest({
      nodeIds: ['a'],
      lookup: mapOf({ a: N('a', { title: '第一行\n第二行' }) }),
    })!
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1)
    expect(out).toContain('第一行 第二行')
  })
})
