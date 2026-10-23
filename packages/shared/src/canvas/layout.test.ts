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

import { distributeNodes } from './layout'

describe('distributeNodes', () => {
  it('x 轴：3 节点等空隙，首尾锚定', () => {
    // a 左缘 0 宽 100；c 左缘 300 宽 100 ⇒ span 用 right：a.right=100, c.right=400
    const nodes = [mk('a', 0, 0, 100, 50), mk('b', 120, 0, 100, 50), mk('c', 300, 0, 100, 50)]
    const r = distributeNodes(nodes, ['a', 'b', 'c'], 'x')
    // first.left=0, last.right=400, totalW=300, gap=(400-0-300)/2=50
    // 中间 b 左缘应 = first.left + w_a + gap = 0+100+50 = 150 ⇒ b.x=150
    expect(r['a']).toBeUndefined() // 首锚定
    expect(r['c']).toBeUndefined() // 尾锚定
    expect(r['b'].x).toBe(150)
  })
  it('x 轴混宽：按包围盒空隙算', () => {
    const nodes = [mk('a', 0, 0, 100, 50), mk('b', 200, 0, 200, 50), mk('c', 600, 0, 100, 50)]
    // first.left=0,last.right=700,totalW=400,gap=(700-400)/2=150 ⇒ b 左缘=0+100+150=250
    const r = distributeNodes(nodes, ['a', 'b', 'c'], 'x')
    expect(r['b'].x).toBe(250)
  })
  it('<3 节点返回空映射（no-op）', () => {
    const nodes = [mk('a', 0, 0), mk('b', 100, 0)]
    expect(distributeNodes(nodes, ['a', 'b'], 'x')).toEqual({})
  })
})

import { computeSnapGuides } from './layout'

describe('computeSnapGuides', () => {
  const drag = { x: 95, y: 200, w: 100, h: 50 } // 左缘 95，距候选 left=100 差 5 ≤ 8
  it('垂直方向最近线命中：被拖左缘吸到候选左缘', () => {
    const cands = [{ id: 'o', box: { x: 100, y: 0, w: 80, h: 80 } }]
    const r = computeSnapGuides(drag, cands)
    expect(r.vertical?.position).toBe(100)
    expect(r.snapped.x).toBe(100) // 左缘对齐到 100
    expect(r.snapped.y).toBe(200)
  })
  it('无命中返回原位置、无 guide', () => {
    const cands = [{ id: 'o', box: { x: 500, y: 500, w: 80, h: 80 } }]
    const r = computeSnapGuides(drag, cands)
    expect(r.vertical).toBeUndefined(); expect(r.horizontal).toBeUndefined()
    expect(r.snapped).toEqual({ x: 95, y: 200 })
  })
  it('hysteresis：prev 线在半径+0.5 释放带内保持', () => {
    const cands = [{ id: 'o', box: { x: 100, y: 0, w: 80, h: 80 } }]
    const r1 = computeSnapGuides(drag, cands)
    const drag2 = { ...drag, x: 108.2 } // 距 prev 100 差 8.2（>radius 8，但 ≤8+0.5 释放带）
    const r2 = computeSnapGuides(drag2, cands, { prev: { vertical: r1.vertical } })
    expect(r2.vertical?.position).toBe(100)
  })
  it('跳过自身：isSelf 候选不命中', () => {
    const cands = [{ id: 'self', box: { x: 100, y: 0, w: 80, h: 80 }, isSelf: true }]
    const r = computeSnapGuides(drag, cands)
    expect(r.vertical).toBeUndefined()
  })
  it('hysteresis 保线时不得把拖拽锚点换到更差的配对（否则节点被拉偏）', () => {
    // 被拖左缘 8.2、候选左缘 0 ⇒ 8.2px > 半径 8，只能靠 prev 保线（释放带内）。
    // 保线只保证「这根线还在」，吸附位置必须用**最近**的拖拽锚点（左缘，off=0），
    // 不能被同线的 centerX 配对覆盖（那会把节点拉到 100 而不是 0）。
    const cands = [{ id: 'o', box: { x: 0, y: 0, w: 200, h: 100 } }]
    const r = computeSnapGuides({ x: 8.2, y: 500, w: 200, h: 100 }, cands, {
      prev: { vertical: { position: 0, sourceNodeId: 'o' } },
    })
    expect(r.vertical?.position).toBe(0)
    expect(r.snapped.x, '按最近锚点（左缘）吸附到 0').toBe(0)
  })
  it('非首要锚点配对：right~right / centerX~centerX 的吸附位置（off≠0）', () => {
    // ⛔ 回归：off = 原点 - 锚点坐标 ⇒ 新原点 = 线 + off。
    //   写反成「线 - off」会把节点放到线的错误一侧（right 配对时右缘对不齐）。
    const r1 = computeSnapGuides(
      { x: 95, y: 300, w: 100, h: 50 },
      [{ id: 'c', box: { x: 120, y: 0, w: 80, h: 80 } }],
    )
    // 被拖右缘 195、候选右缘 200 ⇒ 拖动后右缘应等于 200 ⇒ 新 x = 100
    expect(r1.vertical?.position).toBe(200)
    expect(r1.snapped.x, '右缘对齐到 200 ⇒ 左缘 100').toBe(100)

    const r2 = computeSnapGuides(
      { x: 95, y: 300, w: 100, h: 50 },
      [{ id: 'c', box: { x: 0, y: 0, w: 290, h: 80 } }],
    )
    // 候选很宽 ⇒ 只有 centerX 配对落在半径内：被拖中心 145、候选中心 145
    expect(r2.vertical?.position).toBe(145)
    expect(r2.snapped.x, '中心对齐 145 ⇒ 左缘 95（原地不动）').toBe(95)
  })
})

// ══════════════════════════════════════════════════════
// SP-B R1（2026-10-23）实测反馈「被吸住 / 步阶太大 / 不连贯」平滑化回归
// ══════════════════════════════════════════════════════
describe('computeSnapGuides R1：粘滞释放带 + 切换余量', () => {
  // 两条邻近垂直候选线：left=0 与 left=6（相距 6px，模拟两条边几乎对齐的节点）。
  // ⚠️ 盒宽取 200：把候选自身的 right/centerX 线（100/106）推离拖拽锚点
  //    （left∈[1,12]、right∈[51,62]、cx∈[26,37]），否则它们会混进半径内
  //    把场景搅成「谁更近」的浮点噪声之争（实测踩过：4.6 处 left 与 centerX
  //    距离差 1e-15，任一条都可能赢）。
  const nearCands = [
    { id: 'a', box: { x: 0, y: 0, w: 200, h: 100 } },
    { id: 'b', box: { x: 6, y: 0, w: 200, h: 100 } },
  ]
  /** 释放带专用：只有一条候选线（0），半径内无其他线干扰。 */
  const soloCands = [{ id: 'a', box: { x: 0, y: 0, w: 200, h: 100 } }]
  const dragAt = (x: number) => ({ x, y: 300, w: 50, h: 50 })
  const opts = { snapRadius: 8, hysteresis: 3 }
  const prevA = { vertical: { position: 0, sourceNodeId: 'a' } }

  it('⛔ 回归：prev 线离开释放带（radius+hysteresis）必须脱钩', () => {
    // 旧实现 `if (!keepPrev && dist > radius) continue` 对 prev 配对不设距离上限
    // ⇒ 吸上永不脱钩（只有别的线更近才被顶掉）——正是「被吸住」的体感来源。
    const edge = computeSnapGuides(dragAt(11), soloCands, { ...opts, prev: prevA })
    expect(edge.vertical?.position, '11 = 8+3 释放带边界内仍保持').toBe(0)
    expect(edge.snapped.x, '保持即拉回线上').toBe(0)

    const beyond = computeSnapGuides(dragAt(11.5), soloCands, { ...opts, prev: prevA })
    expect(beyond.vertical, '超出释放带不得再粘住').toBeUndefined()
    expect(beyond.snapped.x, '脱钩后节点自由跟手').toBe(11.5)
  })

  it('⛔ 回归：邻近两线临界点，挑战线需近过 hysteresis 余量才接管（防横跳）', () => {
    // 无余量时鼠标在两线中点（x=3）附近微抖，「谁更近」反复易主 ⇒ 节点在
    // x=0 / x=6 两线间来回跳（不连贯）。有余量 ⇒ 贴住不跳。
    const at3 = computeSnapGuides(dragAt(3), nearCands, { ...opts, prev: prevA })
    expect(at3.vertical?.position, '中点并列仍贴 prev 线').toBe(0)

    const at3_9 = computeSnapGuides(dragAt(3.9), nearCands, { ...opts, prev: prevA })
    expect(at3_9.vertical?.position, '挑战线仅近 0.1（<余量 3）不接管').toBe(0)

    const at4_6 = computeSnapGuides(dragAt(4.6), nearCands, { ...opts, prev: prevA })
    expect(at4_6.vertical?.position, '挑战线近过余量（1.4 < 4.6-3）才接管').toBe(6)
    expect(at4_6.snapped.x, '接管后贴到新线').toBe(6)
  })

  it('接管后反向也要近过余量才换回（迟滞窗口对称，防中点抖动）', () => {
    const at4_6 = computeSnapGuides(dragAt(4.6), nearCands, { ...opts, prev: prevA })
    const prevB = { vertical: at4_6.vertical! }
    const back2 = computeSnapGuides(dragAt(2), nearCands, { ...opts, prev: prevB })
    expect(back2.vertical?.position, '回拖仅近 2（<余量 3）仍贴 b 线').toBe(6)
    const back1 = computeSnapGuides(dragAt(1), nearCands, { ...opts, prev: prevB })
    expect(back1.vertical?.position, 'a 线近过余量（1 < 5-3）才换回').toBe(0)
  })

  it('阈值由调用方传入：CanvasPage 按 1/zoom 换算 ⇒ 屏幕空间手感与缩放无关', () => {
    const cands = [{ id: 'o', box: { x: 100, y: 0, w: 80, h: 80 } }]
    const r4 = computeSnapGuides({ x: 104, y: 200, w: 100, h: 50 }, cands, { snapRadius: 4 })
    expect(r4.vertical?.position, 'dist 4 ≤ 传入半径 4 命中').toBe(100)
    const r5 = computeSnapGuides({ x: 105, y: 200, w: 100, h: 50 }, cands, { snapRadius: 4 })
    expect(r5.vertical, 'dist 5 > 传入半径 4 不命中').toBeUndefined()
  })
})
