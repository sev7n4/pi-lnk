import { describe, expect, it } from 'vitest'
import {
  applySnapOnRelease,
  createGroupFromNodes,
  nextGroupTitle,
  type FlowNode,
} from './useCanvasGrouping'

/**
 * 分组拖拽修复回归锁（2026-10-12）。
 *
 * 生产实测两个缺陷：
 * ① 分组带 `dragHandle: '.group-drag-handle'`，唯一拖拽面是盒体外沿 26px
 *    标题条；fit-view 缩到 ~0.25 倍后屏幕仅 ~6px 高，盒体大面积拖拽无效
 *    （用户感知「3 个分组拖不动」；「分组 2」标题条中心还被媒体子节点元素
 *    拦截）。修复 = 分组整盒可拖。
 * ② 建组命名按「当前分组总数」计数（`分组 ${count}`），取消分组/删除后
 *    总数回落 ⇒ 重名（生产画布 4 个分组里两个「分组 1」；首组还叫
 *    「分组 0」，与 addNode 空组路径 +1 口径不一致）。修复 = 扫占位取最小
 *    空位。
 * ③ 拖拽丝滑化：vue-flow snap-to-grid 在每个 mousemove 实时吸附 20px 网格
 *    （用户感知的「步阶」）⇒ 关掉拖拽中吸附、松手才一次性落格。
 */

function node(id: string, over: Partial<FlowNode> = {}): FlowNode {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: {},
    ...over,
  } as FlowNode
}

describe('nextGroupTitle：取最小未被占用的「分组 N」', () => {
  it('空画布从「分组 1」起（旧口径首组叫「分组 0」）', () => {
    expect(nextGroupTitle([])).toBe('分组 1')
  })

  it('顺次占用：已有 1/2 → 取 3', () => {
    const nodes = [
      node('g1', { type: 'group', data: { title: '分组 1' } }),
      node('g2', { type: 'group', data: { title: '分组 2' } }),
    ]
    expect(nextGroupTitle(nodes)).toBe('分组 3')
  })

  it('取消分组/删除后总数回落也不重名：占位 1/3 → 取最小空位 2', () => {
    // 旧口径 countGroups=2 ⇒ 新组叫「分组 2」，与现存「分组 2」重名；
    // 新口径扫占位，「分组 2」空着才给。
    const nodes = [
      node('g1', { type: 'group', data: { title: '分组 1' } }),
      node('g3', { type: 'group', data: { title: '分组 3' } }),
    ]
    expect(nextGroupTitle(nodes)).toBe('分组 2')
  })

  it('重名占位只挡一个号：现存两个「分组 1」→ 取 2', () => {
    const nodes = [
      node('g1', { type: 'group', data: { title: '分组 1' } }),
      node('g1b', { type: 'group', data: { title: '分组 1' } }),
    ]
    expect(nextGroupTitle(nodes)).toBe('分组 2')
  })

  it('非「分组 N」的自定义名不占数字号', () => {
    const nodes = [node('g', { type: 'group', data: { title: 'rose' } })]
    expect(nextGroupTitle(nodes)).toBe('分组 1')
  })

  it('普通节点的 data.title 不参与占位', () => {
    const nodes = [node('t', { type: 'text', data: { title: '分组 1' } })]
    expect(nextGroupTitle(nodes)).toBe('分组 1')
  })

  it('不修改入参数组', () => {
    const nodes = [node('g1', { type: 'group', data: { title: '分组 1' } })]
    const snapshot = JSON.stringify(nodes)
    nextGroupTitle(nodes)
    expect(JSON.stringify(nodes)).toBe(snapshot)
  })
})

describe('applySnapOnRelease：松手一次性落格，相对阵列不变', () => {
  const starts = new Map([
    ['a', { x: 13, y: 27 }],
    ['b', { x: 101, y: 55 }],
  ])

  it('grid<=0 时原样返回（同一引用，零扰动）', () => {
    const nodes = [node('a', { position: { x: 33, y: 47 } })]
    expect(applySnapOnRelease(nodes, starts, 'a', 0)).toBe(nodes)
  })

  it('锚点不在快照里 → 原样返回', () => {
    const nodes = [node('a', { position: { x: 33, y: 47 } })]
    expect(applySnapOnRelease(nodes, starts, 'ghost', 20)).toBe(nodes)
  })

  it('锚点已落在格线上 → 零吸附量，原样返回', () => {
    // 起点就在格线上且没移动 ⇒ round(20)-20=0
    const nodes = [node('a', { position: { x: 20, y: 40 } })]
    const out = applySnapOnRelease(nodes, new Map([['a', { x: 20, y: 40 }]]), 'a', 20)
    expect(out).toBe(nodes)
  })

  it('单锚点：按起点快照 + 吸附平移量落格（不是无脑 round 当前位置）', () => {
    // a 现位 (33,63) → round 到 (40,60)；起点 (13,27) ⇒ shift (27,33)
    const nodes = [node('a', { position: { x: 33, y: 63 } })]
    const out = applySnapOnRelease(nodes, starts, 'a', 20)
    expect(out[0]!.position).toEqual({ x: 13 + 27, y: 27 + 33 })
  })

  it('多选兄弟平移同一吸附量，相对阵列不变', () => {
    const nodes = [
      node('a', { position: { x: 33, y: 63 } }),
      node('b', { position: { x: 121, y: 95 } }),
    ]
    const out = applySnapOnRelease(nodes, starts, 'a', 20)
    expect(out[0]!.position).toEqual({ x: 40, y: 60 })
    expect(out[1]!.position).toEqual({ x: 128, y: 88 })
    // 相对偏移保持：(128-40, 88-60) == 起点差 (101-13, 55-27)
    expect([out[1]!.position.x - out[0]!.position.x, out[1]!.position.y - out[0]!.position.y])
      .toEqual([88, 28])
  })

  it('不在 dragStarts 里的节点（如已选分组的子节点）不被平移', () => {
    // g 现位 (33,63) → round (40,60)；子节点 c 不在 dragItems ⇒ 不动
    const nodes = [
      node('g', { type: 'group', position: { x: 33, y: 63 } }),
      node('c', { parentNode: 'g', position: { x: 80, y: 80 } }),
    ]
    const out = applySnapOnRelease(nodes, new Map([['g', { x: 13, y: 27 }]]), 'g', 20)
    expect(out[0]!.position).toEqual({ x: 40, y: 60 })
    expect(out[1]!.position).toEqual({ x: 80, y: 80 })
  })

  it('就近吸附：距下格线更近时往下吸（49 → 40）', () => {
    // 起点 0，现位 49，grid 20 ⇒ round(49/20)=round(2.45)=2 ⇒ 40
    const nodes = [node('a', { position: { x: 49, y: 0 } })]
    const out = applySnapOnRelease(nodes, new Map([['a', { x: 0, y: 0 }]]), 'a', 20)
    expect(out[0]!.position.x).toBe(40)
  })

  it('半点向上：正好半格时往上吸（50 → 60，JS Math.round 向 +∞）', () => {
    const nodes = [node('a', { position: { x: 50, y: 0 } })]
    const out = applySnapOnRelease(nodes, new Map([['a', { x: 0, y: 0 }]]), 'a', 20)
    expect(out[0]!.position.x).toBe(60)
  })
})

describe('createGroupFromNodes：默认命名与整盒可拖', () => {
  const scene = (): FlowNode[] => [
    node('n1', { position: { x: 100, y: 100 } }),
    node('n2', { position: { x: 500, y: 400 } }),
    node('existing', { type: 'group', position: { x: 0, y: 0 }, data: { title: '分组 1' } }),
  ]

  it('默认标题走 nextGroupTitle：已有「分组 1」→ 新组「分组 2」', () => {
    const out = createGroupFromNodes(scene(), ['n1', 'n2'])
    expect(out).not.toBeNull()
    const g = out!.nodes.find((n) => n.id === out!.groupId)!
    expect((g.data as { title?: string }).title).toBe('分组 2')
  })

  it('显式传入 groupTitle 时优先使用', () => {
    const out = createGroupFromNodes(scene(), ['n1', 'n2'], '自定义')
    const g = out!.nodes.find((n) => n.id === out!.groupId)!
    expect((g.data as { title?: string }).title).toBe('自定义')
  })

  it('新建分组不带 dragHandle（整盒可拖回归锁）', () => {
    const out = createGroupFromNodes(scene(), ['n1', 'n2'])
    const g = out!.nodes.find((n) => n.id === out!.groupId)!
    expect(g.dragHandle).toBeUndefined()
    expect(g.draggable).toBe(true)
    expect(g.zIndex).toBe(0)
  })

  it('有效性前置：场景里确实已有一个「分组 1」（占位非空）', () => {
    const s = scene()
    const titles = s.filter((n) => n.type === 'group').map((n) => (n.data as { title?: string }).title)
    expect(titles).toEqual(['分组 1'])
  })
})
