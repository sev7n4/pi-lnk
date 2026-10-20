/**
 * 分组侧车行为锁（2026-10-20 分组不再是节点）。
 *
 * 分组数据落 `CanvasData.groups`，框由 overlay 渲染；本文件锁住四条不可回退的语义：
 * 1. 打组不产生新节点（nodes 数量不变），只在 sidecar 里多一条；
 * 2. 解组只删框，子节点绝对坐标不动；
 * 3. 拖框 = 整组平移（子节点一起走）；
 * 4. 同步时自愈：子节点被删/不足 2 个 ⇒ 分组自动解散；框跟着子节点重算。
 */
import { describe, expect, it } from 'vitest'
import type { CanvasGroup } from '@lnkpi/shared'
import {
  createGroupFromSelection,
  detachNodesFromGroups,
  groupRectForChildren,
  moveGroupWithChildren,
  patchGroupColorKey,
  renameGroup,
  syncGroupsToChildren,
  clampGroupChipToViewport,
  ungroupById,
  type FlowNode,
} from './useCanvasGrouping'

function node(id: string, type: string, x: number, y: number): FlowNode {
  return { id, type, position: { x, y }, data: {} } as FlowNode
}

const BASE: FlowNode[] = [
  node('a', 'image', 0, 0),
  node('b', 'text', 400, 0),
  node('c', 'video', 0, 400),
]

describe('分组侧车（不再是节点）', () => {
  it('打组：只加 sidecar，nodes 不变', () => {
    const result = createGroupFromSelection([], BASE, ['a', 'b'])
    expect(result).not.toBeNull()
    expect(result!.groups).toHaveLength(1)
    expect(result!.group.childIds).toEqual(['a', 'b'])
    // 关键判据：没有凭空多出 group 节点
    expect(BASE).toHaveLength(3)
    expect(BASE.some((n) => n.type === 'group')).toBe(false)
  })

  it('打组最少 2 个可用节点（含已分组节点的容错归并）', () => {
    // 仅 1 个节点 ⇒ 真不足，返回 null
    expect(createGroupFromSelection([], BASE, ['a'])).toBeNull()

    const first = createGroupFromSelection([], BASE, ['a', 'b'])!

    // 重选【同一个】已存在分组的全部节点 ⇒ 视为重选，不新建（groups 数量不变）
    const reselect = createGroupFromSelection(first.groups, BASE, ['a', 'b'])!
    expect(reselect.groups).toHaveLength(1)
    expect(reselect.group.id).toBe(first.group.id)

    // 选「已在分组里的 a」+「自由的 c」⇒ 把 a、c 从旧分组摘出后整体归并成新分组
    const merged = createGroupFromSelection(first.groups, BASE, ['a', 'c'])!
    expect(merged).not.toBeNull()
    expect(merged!.group.childIds).toEqual(['a', 'c'])
    // 旧分组（仅剩 b，不足 2 个）已自动解散
    expect(merged!.groups).toHaveLength(1)
    expect(merged!.groups[0].id).toBe(merged!.group.id)
    expect(BASE.some((n) => n.type === 'group')).toBe(false)
  })

  it('打组结果回报 mode：UI 层据此给反馈（静默会被用户读成「打组失败」）', () => {
    const first = createGroupFromSelection([], BASE, ['a', 'b'])!
    expect(first.mode).toBe('created')

    // 全在同一分组内 ⇒ reselect（不新建）
    const again = createGroupFromSelection(first.groups, BASE, ['a', 'b'])!
    expect(again.mode).toBe('reselect')
    expect(again.groups).toHaveLength(1)

    // 跨分组（a 已分组 + c 自由）⇒ merged
    const merged = createGroupFromSelection(first.groups, BASE, ['a', 'c'])!
    expect(merged.mode).toBe('merged')
    expect(merged.group.childIds).toEqual(['a', 'c'])
  })

  it('外框 = 子节点包围盒 + padding', () => {
    const rect = groupRectForChildren(BASE, ['a', 'b'])
    expect(rect).not.toBeNull()
    // a: (0,0,280×280) · b: (400,0,280×160) ⇒ 包围盒 x∈[0,680] y∈[0,280]，
    // 两侧各留 padding 80 ⇒ 宽 680+160=840、高 280+160=440
    expect(rect!.position).toEqual({ x: -80, y: -80 })
    expect(rect!.size).toEqual({ width: 840, height: 440 })
  })

  it('解组：只移除框，子节点坐标不动', () => {
    const created = createGroupFromSelection([], BASE, ['a', 'b'])!
    const after = ungroupById(created.groups, created.group.id)
    expect(after).toEqual([])
    expect(BASE.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 0, y: 400 },
    ])
  })

  it('拖框 = 整组平移（子节点跟着走）', () => {
    const created = createGroupFromSelection([], BASE, ['a', 'b'])!
    const moved = moveGroupWithChildren(created.groups, BASE, created.group.id, { x: 50, y: -20 })
    const byId = Object.fromEntries(moved.nodes.map((n) => [n.id, n.position]))
    expect(byId.a).toEqual({ x: 50, y: -20 })
    expect(byId.b).toEqual({ x: 450, y: -20 })
    // 未入组的节点不动
    expect(byId.c).toEqual({ x: 0, y: 400 })
    const group = moved.groups.find((g) => g.id === created.group.id)!
    expect(group.position).toEqual({ x: created.group.position.x + 50, y: created.group.position.y - 20 })
  })

  it('同步自愈：子节点被删后重算框，不足 2 个则解散', () => {
    const created = createGroupFromSelection([], BASE, ['a', 'b'])!
    const shrunk = syncGroupsToChildren(created.groups, BASE.filter((n) => n.id !== 'b'))
    expect(shrunk).toEqual([])

    const created2 = createGroupFromSelection([], BASE, ['a', 'b'])!
    const movedNodes = BASE.map((n) =>
      n.id === 'b' ? node('b', 'text', 900, 500) : n,
    )
    const synced = syncGroupsToChildren(created2.groups, movedNodes)
    expect(synced).toHaveLength(1)
    expect(synced[0]!.position.x).toBe(-80)
    expect(synced[0]!.size.width).toBe(900 + 280 + 80 - (-80))
  })

  it('删节点时把 id 从分组摘掉', () => {
    const created = createGroupFromSelection([], BASE, ['a', 'b'])!
    const after = detachNodesFromGroups(created.groups, ['b'])
    expect(after).toEqual([]) // 只剩 1 个子节点 ⇒ 分组解散
  })

  it('改色与重命名都是纯字段替换', () => {
    const created = createGroupFromSelection([], BASE, ['a', 'b'])!
    const recolored = patchGroupColorKey(created.groups, created.group.id, 'moss')
    expect(recolored[0]!.colorKey).toBe('moss')
    const reset = patchGroupColorKey(recolored, created.group.id, null)
    expect(reset[0]!.colorKey).toBeUndefined()
    const renamed = renameGroup(created.groups, created.group.id, '  第一幕  ')
    expect(renamed[0]!.title).toBe('第一幕')
  })

  it('分组 id 前缀与节点 id 空间不冲突（sidecar 自有命名空间）', () => {
    const created = createGroupFromSelection([], BASE, ['a', 'b'])!
    expect(created.group.id.startsWith('group-')).toBe(true)
    expect(BASE.some((n) => n.id === created.group.id)).toBe(false)
    const asGroup: CanvasGroup = created.group
    expect(asGroup.childIds).not.toContain(asGroup.id)
  })
})

describe('巨型分组的 chip 视口钳制（clampGroupChipToViewport，v2 屏幕坐标）', () => {
  const rect = { position: { x: -208, y: -142 }, size: { width: 1921, height: 757 } }

  it('框完全可见 ⇒ 返回默认屏幕位（框顶外沿 -32*zoom、左对齐框左缘）', () => {
    const off = clampGroupChipToViewport(
      { position: { x: 100, y: 100 }, size: { width: 400, height: 300 } },
      { x: 0, y: 0, zoom: 1 },
      { width: 1000, height: 800 },
    )!
    expect(off.left).toBe(100)
    expect(off.top).toBe(68)
  })

  it('比视口大的组（生产案例）⇒ chip 钳到窗口 margin 内', () => {
    // 生产实况：zoom 0.554，框四边全在窗口外/被悬浮组件遮住
    const off = clampGroupChipToViewport(rect, { x: 109, y: 72, zoom: 0.554 }, { width: 1080, height: 428 })!
    expect(off.left).toBe(8)
    expect(off.top).toBe(8)
  })

  it('框与窗口无交集 ⇒ null（调用方隐藏 chip）', () => {
    expect(clampGroupChipToViewport(rect, { x: 109, y: 900, zoom: 0.554 }, { width: 1080, height: 428 })).toBeNull()
    expect(clampGroupChipToViewport({ position: { x: 2000, y: 0 }, size: { width: 300, height: 300 } }, { x: 0, y: 0, zoom: 1 }, { width: 1000, height: 800 })).toBeNull()
  })

  it('窗口尺寸非法或 zoom 非法 ⇒ null', () => {
    expect(clampGroupChipToViewport(rect, { x: 0, y: 0, zoom: 1 }, { width: 0, height: 0 })).toBeNull()
    expect(clampGroupChipToViewport(rect, { x: 0, y: 0, zoom: 0 }, { width: 1000, height: 800 })).toBeNull()
  })

  it('框顶可见但左缘出界 ⇒ 只钳 left，top 保持框顶外沿设计位', () => {
    const off = clampGroupChipToViewport(
      { position: { x: -300, y: 100 }, size: { width: 900, height: 300 } },
      { x: 0, y: 0, zoom: 1 },
      { width: 1000, height: 800 },
    )!
    expect(off.top).toBe(68)
    expect(off.left).toBe(8)
  })
})
