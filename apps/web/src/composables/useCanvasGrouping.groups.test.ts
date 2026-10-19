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

  it('打组最少 2 个未分组节点', () => {
    expect(createGroupFromSelection([], BASE, ['a'])).toBeNull()
    const first = createGroupFromSelection([], BASE, ['a', 'b'])!
    // 已在分组里的节点不能再次入组（不建嵌套分组）
    expect(createGroupFromSelection(first.groups, BASE, ['a', 'c'])).toBeNull()
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
