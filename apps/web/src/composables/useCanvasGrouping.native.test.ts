/**
 * 分组「运行态 ⇄ 持久化」两个边界的判据（2026-10-21 分组回归原生节点形态）。
 *
 * 背景：#494 把分组从 vue-flow 节点改成 `CanvasData.groups` 侧车，导致 PC 端
 * 只能点 26px 的小胶囊交互，且 overlay 手搓的 viewport 变换层上挂着
 * `overflow:hidden` ⇒ 拖动时框被「塞进信封」式淹没。本批把**渲染层**改回
 * vue-flow 原生父子节点（`parentNode` + `extent:'parent'` + `expandParent`），
 * 但**持久化格式一行不改**：加载时 `materializeGroups` 物化成父节点，
 * 保存时 `foldGroups` 折叠回 `CanvasGroup[]` + 子节点绝对坐标。
 *
 * 本文件锁住四条不可回退的语义：
 *  1. 物化：CanvasGroup → group 节点 + 子节点挂 parentNode、坐标转相对；
 *  2. 折叠：group 节点绝不落库，子节点坐标必须逐值回到绝对；
 *  3. 往返幂等：fold(materialize(n, g)) ≡ (n, g)；
 *  4. 脏数据 fail-open + 不支持嵌套分组：不能让整块画布白屏。
 */
import { describe, expect, it } from 'vitest'
import type { CanvasGroup } from '@lnkpi/shared'
import {
  GROUP_PADDING,
  createGroupFromSelection,
  detachNodesFromGroupNodes,
  foldGroups,
  getAbsolutePosition,
  isGroupNode,
  materializeGroups,
  nextGroupTitle,
  patchGroupNodeData,
  resizeGroupToFitChildren,
  syncGroupsToFitChildren,
  ungroupById,
  type FlowNode,
} from './useCanvasGrouping'

function node(id: string, type: string, x: number, y: number, extra: Partial<FlowNode> = {}): FlowNode {
  return { id, type, position: { x, y }, data: {}, ...extra } as FlowNode
}

/** a: image 280×280 @(100,100)；b: text 280×160 @(600,100) ⇒ 包围盒 x 100..880 / y 100..380 */
const BASE: FlowNode[] = [node('a', 'image', 100, 100), node('b', 'text', 600, 100)]

const GROUP: CanvasGroup = {
  id: 'group-1',
  title: '第一组',
  childIds: ['a', 'b'],
  position: { x: 20, y: 20 },
  size: { width: 960, height: 440 },
}

const byId = (nodes: FlowNode[], id: string) => {
  const found = nodes.find((n) => n.id === id)
  if (!found) throw new Error(`测试样本缺节点 ${id}`)
  return found
}

describe('分组物化：CanvasData.groups → vue-flow 父节点', () => {
  it('产出一个 group 父节点，子节点挂 parentNode 且坐标转相对', () => {
    const next = materializeGroups(BASE, [GROUP])
    expect(next).toHaveLength(3)

    const g = byId(next, 'group-1')
    expect(g.type).toBe('group')
    expect(g.position).toEqual({ x: 20, y: 20 })
    // 尺寸走 style（vue-flow 测量前也能撑出正确外框）
    expect(g.style).toMatchObject({ width: '960px', height: '440px' })
    expect(g.zIndex).toBe(0)
    expect(g.data).toMatchObject({ title: '第一组', childIds: ['a', 'b'] })

    for (const id of ['a', 'b'] as const) {
      const child = byId(next, id)
      expect(child.parentNode).toBe('group-1')
      expect(child.extent).toBe('parent')
      expect(child.expandParent).toBe(true)
      expect(child.zIndex).toBe(1)
    }
    expect(byId(next, 'a').position).toEqual({ x: 80, y: 80 })
    expect(byId(next, 'b').position).toEqual({ x: 580, y: 80 })
  })

  it('子节点本就带 parentNode 时，先算绝对再换算相对（不复读残留 parentNode 的旧相对值）', () => {
    // b 挂在 some-parent 下，相对 (10,10)；some-parent 绝对在 (590,90) ⇒ b 绝对 (600,100)
    const dirty: FlowNode[] = [
      node('a', 'image', 100, 100),
      node('some-parent', 'image', 590, 90),
      node('b', 'text', 10, 10, { parentNode: 'some-parent' }),
    ]
    const next = materializeGroups(dirty, [GROUP])
    expect(byId(next, 'b').position).toEqual({ x: 580, y: 80 })
  })

  it('同一节点被两个分组点名时只归第一个组（后到的被跳过，不产生孤儿相对坐标）', () => {
    const next = materializeGroups(BASE, [GROUP, { ...GROUP, id: 'group-2', position: { x: 0, y: 0 } }])
    expect(byId(next, 'a').parentNode).toBe('group-1')
    expect(byId(next, 'b').parentNode).toBe('group-1')
  })
})

describe('分组折叠：vue-flow 父节点 → CanvasData.groups（落库形态）', () => {
  it('⛔ group 节点绝不落库，子节点坐标逐值回到绝对坐标', () => {
    const folded = foldGroups(materializeGroups(BASE, [GROUP]))
    expect(folded.nodes).toHaveLength(2)
    expect(folded.nodes.some(isGroupNode)).toBe(false)
    expect(byId(folded.nodes, 'a').position).toEqual({ x: 100, y: 100 })
    expect(byId(folded.nodes, 'b').position).toEqual({ x: 600, y: 100 })
    // 父子字段必须清干净：残留 parentNode 会让下次加载把绝对坐标当相对坐标渲染（整组散架）
    for (const child of folded.nodes) {
      expect(child.parentNode).toBeUndefined()
      expect(child.extent).toBeUndefined()
      expect(child.expandParent).toBeUndefined()
    }
  })

  it('往返幂等：fold(materialize(n, g)) ≡ (n, g)（nodes 与 groups 都比）', () => {
    const folded = foldGroups(materializeGroups(BASE, [GROUP]))
    expect(folded.groups).toEqual([GROUP])
    // ⛔ nodes 也要比：只比 groups 的「往返幂等」是假判据 —— 把 fold 的
    // 「子节点回绝对坐标」改成直接透传相对值时它照样绿（变异实测）。
    expect(folded.nodes.map((n) => ({ id: n.id, position: n.position }))).toEqual(
      BASE.map((n) => ({ id: n.id, position: n.position })),
    )
  })

  it('空子节点的分组不落库（脏数据不留空壳）', () => {
    const lone = materializeGroups([node('a', 'image', 0, 0)], [
      { ...GROUP, childIds: ['a'] },
    ])
    expect(lone.some(isGroupNode)).toBe(false)
    expect(foldGroups(lone).groups).toEqual([])
  })
})

describe('分组物化：脏数据 fail-open（存量画布自愈，不得白屏）', () => {
  it('size 为 0 / NaN / 缺失 ⇒ 回退「子节点包围盒 + GROUP_PADDING」', () => {
    for (const size of [
      { width: 0, height: 0 },
      { width: Number.NaN, height: Number.NaN },
      undefined as unknown as { width: number; height: number },
    ]) {
      const next = materializeGroups(BASE, [{ ...GROUP, size }])
      const g = byId(next, 'group-1')
      // 包围盒 780×280 + 2×80 留白
      expect(g.position).toEqual({ x: 100 - GROUP_PADDING, y: 100 - GROUP_PADDING })
      expect(g.style).toMatchObject({
        width: `${780 + GROUP_PADDING * 2}px`,
        height: `${280 + GROUP_PADDING * 2}px`,
      })
    }
  })

  it('childIds 指向已删节点 ⇒ 静默丢弃；有效子节点不足 2 个 ⇒ 整个分组不物化', () => {
    const partial = materializeGroups(BASE, [{ ...GROUP, childIds: ['a', 'ghost'] }])
    expect(partial.some(isGroupNode)).toBe(false)
    expect(byId(partial, 'a').parentNode).toBeUndefined()

    const both: FlowNode[] = [node('a', 'image', 0, 0), node('b', 'text', 400, 0), node('c', 'video', 0, 400)]
    const next = materializeGroups(both, [{ ...GROUP, childIds: ['c', 'ghost-1', 'ghost-2'] }])
    expect(next.some(isGroupNode)).toBe(false)
    for (const id of ['a', 'b', 'c']) expect(byId(next, id).parentNode).toBeUndefined()
  })

  it('不支持嵌套分组：childIds 里的 group 节点被跳过', () => {
    const nodes: FlowNode[] = [
      ...BASE,
      node('c', 'video', 1000, 100),
    ]
    const next = materializeGroups(nodes, [
      GROUP,
      { ...GROUP, id: 'group-2', childIds: ['c', 'group-1'] },
    ])
    // group-2 的有效子节点只剩 c（不足 2）⇒ 不物化；c 也不被挂进任何组
    expect(next.filter(isGroupNode)).toHaveLength(1)
    expect(byId(next, 'c').parentNode).toBeUndefined()
  })

  it('⛔ group 节点不得带 dragHandle —— 那会把整框可拖退回「只抓 26px 标题条」', () => {
    // 真正的开关在节点对象上（vue-flow 从 node.dragHandle 读），组件层看不到它。
    // 变异实测：只在组件模板上写 drag-handle 属性是抓不到这个风险的，必须在这里钉。
    const next = materializeGroups(BASE, [GROUP])
    const g = byId(next, 'group-1')
    expect(Object.keys(g)).not.toContain('dragHandle')
    // 整框可拖的正面判据：draggable 显式为 true（不是靠全局 nodesDraggable 兜）
    expect(g.draggable).toBe(true)
    expect(g.selectable).toBe(true)
  })

  it('groups 缺失 / 空数组 ⇒ 原样返回等价引用（无分组画布零扰动）', () => {
    expect(materializeGroups(BASE, undefined).map((n) => n.id)).toEqual(['a', 'b'])
    expect(materializeGroups(BASE, []).map((n) => n.id)).toEqual(['a', 'b'])
    expect(isGroupNode(node('g', 'group', 0, 0))).toBe(true)
    expect(isGroupNode(node('a', 'image', 0, 0))).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════
// 以下覆盖「运行态内的分组操作」：打组 / 解组 / 改名改色 / 摘除 / 自适应尺寸
// ══════════════════════════════════════════════════════════

/** a(100,100) image 280×280 · b(600,100) text 280×160 · c(0,400) video 320×320 */
const THREE: FlowNode[] = [node('a', 'image', 100, 100), node('b', 'text', 600, 100), node('c', 'video', 0, 400)]

/** 三个节点的分组：包围盒 x 100..880 / y 100..720 ⇒ (20,20) 960×800 */
const GROUP3: CanvasGroup = {
  id: 'g3',
  title: '三件组',
  childIds: ['a', 'b', 'c'],
  position: { x: 20, y: 20 },
  size: { width: 960, height: 800 },
}

describe('打组：选区 → 新分组节点（保留 #494 的容错语义）', () => {
  it('全新打组：产出一个 group 节点，子节点转相对', () => {
    const result = createGroupFromSelection(BASE, ['a', 'b'])
    expect(result).not.toBeNull()
    expect(result!.mode).toBe('created')
    expect(result!.childIds).toEqual(['a', 'b'])
    expect(result!.groupId).toMatch(/^group-/)
    expect(result!.nodes).toHaveLength(3)

    const g = byId(result!.nodes, result!.groupId)
    expect(isGroupNode(g)).toBe(true)
    expect(g.position).toEqual({ x: 20, y: 20 })
    expect(g.style).toMatchObject({ width: '940px', height: '440px' })
    expect(byId(result!.nodes, 'a').parentNode).toBe(result!.groupId)
    expect(byId(result!.nodes, 'b').position).toEqual({ x: 580, y: 80 })
  })

  it('可打组节点不足 2 个 ⇒ null（不打组、也不静默建空壳）', () => {
    expect(createGroupFromSelection(BASE, ['a'])).toBeNull()
    expect(createGroupFromSelection(BASE, ['ghost'])).toBeNull()
  })

  it('reselect：所选节点本就同属一个分组 ⇒ 只重选，不新建', () => {
    const first = createGroupFromSelection(BASE, ['a', 'b'])!
    const again = createGroupFromSelection(first.nodes, ['a', 'b'])!
    expect(again.mode).toBe('reselect')
    expect(again.groupId).toBe(first.groupId)
    expect(again.nodes).toBe(first.nodes)
  })

  it('merged：横跨两个分组 ⇒ 先从原组摘出再归并成一个新组（被摘空的旧组自动解散）', () => {
    // 先物化两个分组：g1={a,b}、g2={c,d}；再框选 a（属 g1）+ c（属 g2）
    const four: FlowNode[] = [...THREE, node('d', 'audio', 600, 400)]
    const withTwoGroups = materializeGroups(four, [
      { ...GROUP3, id: 'g1', title: '组一', childIds: ['a', 'b'], size: { width: 780, height: 360 } },
      { id: 'g2', title: '组二', childIds: ['c', 'd'], position: { x: -80, y: 320 }, size: { width: 1000, height: 480 } },
    ])
    expect(withTwoGroups.filter(isGroupNode)).toHaveLength(2)

    const merged = createGroupFromSelection(withTwoGroups, ['a', 'c'], '合并组')!
    expect(merged.mode).toBe('merged')
    expect([...merged.childIds].sort()).toEqual(['a', 'c'])
    expect(merged.nodes.filter(isGroupNode)).toHaveLength(1)
    expect(byId(merged.nodes, merged.groupId).data).toMatchObject({ title: '合并组' })
    // 两个旧组都被摘空（各只剩 1 个）⇒ 已解散，b/d 回顶层且保持绝对坐标
    expect(byId(merged.nodes, 'b').parentNode).toBeUndefined()
    expect(byId(merged.nodes, 'd').parentNode).toBeUndefined()
    expect(byId(merged.nodes, 'b').position).toEqual({ x: 600, y: 100 })
    expect(byId(merged.nodes, 'd').position).toEqual({ x: 600, y: 400 })
  })
})

describe('解组：删框留节点', () => {
  it('group 节点消失，子节点坐标回绝对、父子字段清空', () => {
    const nodes = materializeGroups(THREE, [GROUP3])
    const next = ungroupById(nodes, 'g3')
    expect(next).not.toBeNull()
    expect(next!).toHaveLength(3)
    expect(next!.some(isGroupNode)).toBe(false)
    expect(byId(next!, 'a').position).toEqual({ x: 100, y: 100 })
    expect(byId(next!, 'c').position).toEqual({ x: 0, y: 400 })
    for (const n of next!) {
      expect(n.parentNode).toBeUndefined()
      expect(n.extent).toBeUndefined()
      expect(n.expandParent).toBeUndefined()
    }
  })

  it('解组后再 fold，子节点绝对坐标与解组前一致（防 parentNode 悬空导致坐标漂移）', () => {
    const nodes = materializeGroups(THREE, [GROUP3])
    const before = nodes.map((n) => getAbsolutePosition(n, nodes))
    const after = ungroupById(nodes, 'g3')!
    const folded = foldGroups(after)
    expect(folded.nodes.map((n) => n.position)).toEqual(
      before.filter((_, i) => nodes[i] && !isGroupNode(nodes[i])),
    )
  })

  it('groupId 不存在 ⇒ null（不误删任何节点）', () => {
    expect(ungroupById(BASE, 'nope')).toBeNull()
  })
})

describe('改分组属性：只动目标 group 节点的 data', () => {
  it('改标题 / 改色 / 清色', () => {
    const nodes = materializeGroups(BASE, [{ ...GROUP, colorKey: 'moss' }])
    const renamed = patchGroupNodeData(nodes, 'group-1', { title: '新名字' })
    expect(byId(renamed, 'group-1').data).toMatchObject({ title: '新名字', colorKey: 'moss' })

    const cleared = patchGroupNodeData(renamed, 'group-1', { colorKey: null })
    expect(byId(cleared, 'group-1').data?.colorKey).toBeUndefined()

    // 非目标节点保持原引用（浅比较即可证「没被无谓拷贝/改动」）
    expect(byId(cleared, 'a')).toBe(byId(renamed, 'a'))
  })

  it('groupId 不存在 ⇒ 原样返回（幂等，零扰动）', () => {
    const nodes = materializeGroups(BASE, [GROUP])
    expect(patchGroupNodeData(nodes, 'nope', { title: 'x' })).toBe(nodes)
  })
})

describe('摘除节点：分组自愈', () => {
  it('摘掉 1 个 ⇒ 剩余不足 2 ⇒ 分组自动解散，子节点回顶层', () => {
    const nodes = materializeGroups(BASE, [GROUP])
    const next = detachNodesFromGroupNodes(nodes, ['a'])
    expect(next.some(isGroupNode)).toBe(false)
    expect(byId(next, 'b').parentNode).toBeUndefined()
    expect(byId(next, 'b').position).toEqual({ x: 600, y: 100 })
  })

  it('3 节点分组摘掉 1 个 ⇒ 分组存活且 childIds 收缩', () => {
    const nodes = materializeGroups(THREE, [GROUP3])
    const next = detachNodesFromGroupNodes(nodes, ['a'])
    expect(next.filter(isGroupNode)).toHaveLength(1)
    expect(byId(next, 'g3').data?.childIds).toEqual(['b', 'c'])
    expect(byId(next, 'c').parentNode).toBe('g3')
  })

  it('空 removals ⇒ 返回原数组引用（幂等，不触发 nodes 引用抖动）', () => {
    const nodes = materializeGroups(BASE, [GROUP])
    expect(detachNodesFromGroupNodes(nodes, [])).toBe(nodes)
  })
})

describe('分组尺寸自适应：extent=parent 撑大父框后要重算 CanvasGroup.size', () => {
  it('resizeGroupToFitChildren：外框贴子节点包围盒 + 留白，子节点绝对位置不变', () => {
    // 物化后子节点是相对坐标；先手动把 b 拖远（模拟拖子节点到边缘触发 expandParent）
    const nodes = materializeGroups(BASE, [GROUP])
    const dragged = nodes.map((n) =>
      n.id === 'b' ? ({ ...n, position: { x: 700, y: 300 } } as FlowNode) : n,
    )
    const before = dragged.map((n) => getAbsolutePosition(n, dragged))

    const next = resizeGroupToFitChildren(dragged, 'group-1')
    const g = byId(next, 'group-1')
    // 相对包围盒 x 80..980 / y 80..460 ⇒ 尺寸 900×380 + 2×80 留白
    expect(g.style).toMatchObject({ width: '1060px', height: '540px' })
    // 子节点绝对坐标必须逐个不变（框变大只是「让位」，不是搬东西）
    for (const n of dragged) {
      if (isGroupNode(n)) continue
      expect(getAbsolutePosition(byId(next, n.id), next)).toEqual(
        before[dragged.indexOf(n)],
      )
    }
  })

  it('syncGroupsToFitChildren 幂等：已贴合时返回原数组引用', () => {
    const nodes = materializeGroups(BASE, [GROUP])
    const once = syncGroupsToFitChildren(nodes)
    const twice = syncGroupsToFitChildren(once)
    expect(twice).toBe(once)
  })

  it('syncGroupsToFitChildren：子节点被拖远后自动把框撑大', () => {
    const nodes = materializeGroups(BASE, [GROUP])
    const dragged = nodes.map((n) =>
      n.id === 'b' ? ({ ...n, position: { x: 700, y: 300 } } as FlowNode) : n,
    )
    const next = syncGroupsToFitChildren(dragged)
    expect(byId(next, 'group-1').style).toMatchObject({ width: '1060px', height: '540px' })
  })
})

describe('分组命名：最小空位口径（删组后不重名）', () => {
  const withTitles = (...titles: string[]): FlowNode[] => [
    ...BASE,
    ...titles.map(
      (t, i) =>
        ({
          id: `g${i}`,
          type: 'group',
          position: { x: 0, y: 0 },
          data: { title: t, childIds: [] },
        }) as unknown as FlowNode,
    ),
  ]

  it('现存「分组 1」「分组 3」⇒ 新建得到「分组 2」', () => {
    expect(nextGroupTitle(withTitles('分组 1', '分组 3'))).toBe('分组 2')
  })

  it('「分组 1」「分组 2」都在 ⇒ 取最小空位「分组 3」（不按分组总数算）', () => {
    expect(nextGroupTitle(withTitles('分组 1', '分组 2'))).toBe('分组 3')
  })

  it('无分组 ⇒ 「分组 1」', () => {
    expect(nextGroupTitle(BASE)).toBe('分组 1')
  })
})
