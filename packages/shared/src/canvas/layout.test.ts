import { describe, expect, it } from 'vitest'
import {
  getAbsolutePosition,
  getNodeSize,
  placeBatchNodes,
  type LayoutNode,
} from './layout'
import { rectsOverlap, type Rect } from './workflowImportPlacement'

function node(id: string, type: string, x: number, y: number, parentNode?: string): LayoutNode {
  return { id, type, position: { x, y }, data: {}, parentNode }
}

describe('placeBatchNodes（SP-A 放置内核）', () => {
  it('空画布首批：从 (80,80) 链式右向，间距 40', () => {
    const out = placeBatchNodes(
      [],
      [
        { key: 'a', type: 'image' },
        { key: 'b', type: 'image' },
        { key: 'c', type: 'image' },
      ],
    )
    expect(out.get('a')).toEqual({ x: 80, y: 80 })
    expect(out.get('b')).toEqual({ x: 400, y: 80 }) // 80 + 280 + 40
    expect(out.get('c')).toEqual({ x: 720, y: 80 })
  })

  it('边引用锚点优先于分量锚点：落被引用节点右缘', () => {
    const existing = [
      node('n1', 'image', 1000, 500),
      node('n2', 'image', 2000, 900), // 孤立点
      node('n3', 'text', 1200, 700),
    ]
    const out = placeBatchNodes(existing, [{ key: 'a', type: 'image' }], [
      { source: 'n3', target: 'a' }, // target 'a' 是本批 key，不计锚点；source n3 计 1 次
    ])
    expect(out.get('a')).toEqual({ x: 1200 + 280 + 40, y: 700 })
  })

  it('无引用边：锚点取最大弱连通分量 bbox 右缘，离群点不进锚点', () => {
    const existing = [
      node('n1', 'image', 1000, 500),
      node('n3', 'text', 1200, 700), // 与 n1 同分量（既有边 n1->n3）
      node('n2', 'image', 4000, 900), // 离群点，不得影响锚点
    ]
    const out = placeBatchNodes(existing, [{ key: 'a', type: 'image' }], [
      { source: 'n1', target: 'n3' },
    ])
    // 分量 {n1,n3} bbox：x 1000..1480, y 500..860 ⇒ 右缘 (1520, 500)
    expect(out.get('a')).toEqual({ x: 1520, y: 500 })
  })

  it('分组子节点按绝对坐标参与避碰', () => {
    const existing = [node('g', 'group', 1000, 1000), node('c1', 'image', 40, 40, 'g')]
    const out = placeBatchNodes(
      existing,
      [
        { key: 'a', type: 'image' },
        { key: 'b', type: 'image' },
      ],
      [],
    )
    // 无引用边 ⇒ 分量各自单点并列 ⇒ 取 bbox 面积大者：{c1} 面积 78400 > {g} 44800
    // c1 绝对 (1040,1040) ⇒ 锚点右缘 (1360,1040)
    expect(out.get('a')).toEqual({ x: 1360, y: 1040 })
    const b = out.get('b')!
    const bRect: Rect = { x: b.x, y: b.y, width: 280, height: 280 }
    const c1Rect: Rect = { x: 1040, y: 1040, width: 280, height: 280 }
    expect(rectsOverlap(bRect, c1Rect, 12)).toBe(false)
  })

  it('密集区：候选点被占时垂直步进避让', () => {
    const existing = [node('n1', 'image', 400, 80), node('n2', 'image', 720, 80)]
    const out = placeBatchNodes(existing, [{ key: 'a', type: 'image' }], [
      { source: 'n1', target: 'a' }, // 锚点 = n1 右缘 (720,80)，该处被 n2 占据
    ])
    // n2 绝对范围 y 68..372（pad 12 膨胀）⇒ 垂直步进到 400 才不相交
    expect(out.get('a')).toEqual({ x: 720, y: 400 })
  })

  it('长链：超行宽 1120 换行', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, type: 'image' }))
    const out = placeBatchNodes([], items)
    expect(out.get('k0')).toEqual({ x: 80, y: 80 })
    expect(out.get('k1')).toEqual({ x: 400, y: 80 })
    expect(out.get('k2')).toEqual({ x: 720, y: 80 })
    expect(out.get('k3')).toEqual({ x: 80, y: 400 }) // 换行：y = 80 + 280 + 40
    expect(out.get('k4')).toEqual({ x: 400, y: 400 })
  })

  it('确定性：同输入两次调用逐点相等', () => {
    const existing = [node('n1', 'image', 300, 300)]
    const items = [
      { key: 'a', type: 'image' },
      { key: 'b', type: 'video' },
    ]
    const first = placeBatchNodes(existing, items, [{ source: 'n1', target: 'a' }])
    const second = placeBatchNodes(existing, items, [{ source: 'n1', target: 'a' }])
    expect([...first.entries()]).toEqual([...second.entries()])
  })

  it('网格吸附：输出均为 20 倍数', () => {
    const existing = [node('n1', 'image', 413, 257)]
    const out = placeBatchNodes(existing, [{ key: 'a', type: 'text' }])
    for (const p of out.values()) {
      expect(p.x % 20).toBe(0)
      expect(p.y % 20).toBe(0)
    }
  })

  it('脏数据 existing：position NaN / 无 type 不抛错，输出仍网格吸附', () => {
    const dirty = [
      { id: 'd1', type: '', position: { x: Number.NaN, y: Number.NaN }, data: {} },
      { id: 'd2', position: { x: 100, y: 100 }, data: {} },
    ] as unknown as LayoutNode[]
    const out = placeBatchNodes(dirty, [{ key: 'a', type: 'image' }])
    const p = out.get('a')!
    expect(Number.isFinite(p.x)).toBe(true)
    expect(Number.isFinite(p.y)).toBe(true)
    expect(p.x % 20).toBe(0)
    expect(p.y % 20).toBe(0)
  })

  it('空 items 返回空 Map', () => {
    expect(placeBatchNodes([node('n1', 'image', 0, 0)], []).size).toBe(0)
  })
})

describe('上移回归（getNodeSize / getAbsolutePosition 逐字等价）', () => {
  it('getNodeSize：style/dimensions 优先于 NODE_SIZES 表', () => {
    expect(getNodeSize({ id: 'x', type: 'image', position: { x: 0, y: 0 }, data: {} })).toEqual({
      w: 280,
      h: 280,
    })
    expect(
      getNodeSize({
        id: 'x',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {},
        dimensions: { width: 100, height: 50 },
      }),
    ).toEqual({ w: 100, h: 50 })
    expect(
      getNodeSize({
        id: 'x',
        type: 'unknown-type',
        position: { x: 0, y: 0 },
        data: {},
        style: { width: '120px', height: 60 },
      }),
    ).toEqual({ w: 120, h: 60 })
  })

  it('getAbsolutePosition：嵌套分组逐级累加', () => {
    const nodes = [
      node('g1', 'group', 100, 100),
      node('g2', 'group', 50, 50, 'g1'),
      node('c', 'image', 10, 20, 'g2'),
    ]
    expect(getAbsolutePosition(nodes[2], nodes)).toEqual({ x: 160, y: 170 })
  })
})

import { alignNodes, type AlignSixWay } from './layout'

function mk(id: string, x: number, y: number, w = 280, h = 160, parent?: string): LayoutNode {
  return { id, type: 'text', position: { x, y }, dimensions: { width: w, height: h }, ...(parent ? { parentNode: parent } : {}) } as LayoutNode
}

describe('alignNodes', () => {
  it('left：选中集最小左缘对齐', () => {
    const nodes = [mk('a', 100, 0), mk('b', 300, 0, 280, 280), mk('c', 0, 500)]
    const r = alignNodes(nodes, ['a', 'b'], 'left')
    expect(r['a'].x).toBe(100); expect(r['b'].x).toBe(100) // 都移到 a 的左缘
    expect(r['c']).toBeUndefined()
  })
  it('right：最大右缘对齐（b 右缘=580）', () => {
    const nodes = [mk('a', 100, 0), mk('b', 300, 0, 280, 280)]
    const r = alignNodes(nodes, ['a', 'b'], 'right')
    expect(r['a'].x).toBe(580 - 280); expect(r['b'].x).toBe(300)
  })
  it('centerH：以选中集水平中轴对齐', () => {
    const nodes = [mk('a', 100, 0), mk('b', 300, 0, 280, 280)]
    // 选中集左缘 100 / 右缘 580 → 中轴 340；a 宽 280 → 左缘 200
    const r = alignNodes(nodes, ['a', 'b'], 'centerH')
    expect(r['a'].x).toBe(200); expect(r['b'].x).toBe(340 - 140)
  })
  it('含 parentNode：结果减回 parent 偏移（parent 在 1000,1000）', () => {
    const parent = mk('p', 1000, 1000, 600, 600)
    const child = mk('a', 100, 100, 280, 160, 'p') // 局部 100,100，绝对 1100,1100
    const nodes = [parent, child]
    const r = alignNodes(nodes, ['a'], 'left')
    // 绝对左缘 1100，无他者 ⇒ 目标=1100；局部 = 1100 - (绝对1100 - 局部100) = 100（不变）
    expect(r['a'].x).toBe(100)
  })
  it('空集返回空映射', () => {
    expect(alignNodes([mk('a', 0, 0)], [], 'left')).toEqual({})
  })
})
