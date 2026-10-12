import { describe, expect, it } from 'vitest'
import {
  GROUP_PADDING,
  restoreGroupHierarchy,
  syncGroupsToFitChildren,
  type FlowNode,
} from './useCanvasGrouping'

/**
 * 刷新加载自愈回归锁（2026-10-12）。
 *
 * 持久化（flowToCanvasData）只存 id/type/position/data —— group 的 style 尺寸
 * 与子节点的 parentNode 父子关系全被丢弃，刷新后整组散架（用户实测截图：
 * 分组塌缩成 280×160 小卡悬在画布顶部，节点全部逃出）。
 *
 * 锁定：① 子节点回填 parentNode/extent/expandParent/zIndex；
 * ② group 回填 dragHandle/zIndex/尺寸（按子节点相对包围盒 + 兜底尺寸表估算）；
 * ③ 幂等（跑两遍结果一致，完好画布零扰动）；④ 坏数据容错（childIds 指向
 * 不存在节点 / 指向 group 自身时跳过）；⑤ 测量后精修 syncGroupsToFitChildren
 * 按真实 dimensions 重算、已贴合时返回原引用。
 */

/** 模拟「刷新后从服务端读回」的形状：无 style / 无 parentNode / 无 zIndex。 */
function persistedScene(): FlowNode[] {
  return [
    {
      id: 'group-1',
      type: 'group',
      position: { x: 500, y: 400 },
      data: { title: '分组 0', childIds: ['img-1', 'img-2'] },
    },
    // 子节点 position 是相对 group 的坐标（createGroupFromNodes 归一化后 min=GROUP_PADDING）
    { id: 'img-1', type: 'image', position: { x: GROUP_PADDING, y: GROUP_PADDING }, data: {} },
    {
      id: 'img-2',
      type: 'image',
      position: { x: GROUP_PADDING + 300, y: GROUP_PADDING + 200 },
      data: {},
    },
    { id: 'solo-1', type: 'text', position: { x: 0, y: 0 }, data: {} },
  ] as unknown as FlowNode[]
}

describe('restoreGroupHierarchy：刷新后按 childIds 重建分组', () => {
  it('有效性前置：persistedScene 确实是「散架」形状（无 parentNode / 无 style）', () => {
    const scene = persistedScene()
    expect(scene[0]!.parentNode).toBeUndefined()
    expect(scene[0]!.style).toBeUndefined()
    expect((scene[1] as { parentNode?: string }).parentNode).toBeUndefined()
  })

  it('子节点回填 parentNode/extent/expandParent/zIndex，group 位置不动', () => {
    const out = restoreGroupHierarchy(persistedScene())
    const g = out.find((n) => n.id === 'group-1')!
    const c1 = out.find((n) => n.id === 'img-1')!
    const c2 = out.find((n) => n.id === 'img-2')!
    const solo = out.find((n) => n.id === 'solo-1')!

    expect(c1.parentNode).toBe('group-1')
    expect(c1.extent).toBe('parent')
    expect(c1.expandParent).toBe(true)
    expect(c1.zIndex).toBe(1)
    expect(c2.parentNode).toBe('group-1')
    // 非子节点零扰动
    expect(solo.parentNode).toBeUndefined()
    // group 位置保持持久化值（子节点相对坐标归位 = 视觉复原）
    expect(g.position).toEqual({ x: 500, y: 400 })
  })

  it('group 回填 dragHandle/zIndex，尺寸 = 子节点相对包围盒 + 2×GROUP_PADDING', () => {
    const out = restoreGroupHierarchy(persistedScene())
    const g = out.find((n) => n.id === 'group-1')!
    expect(g.dragHandle).toBe('.group-drag-handle')
    expect(g.zIndex).toBe(0)
    expect(g.selectable).toBe(true)
    // image 兜底 280×280：maxX = 80+300+280=660, maxY = 80+200+280=560, min=80
    const style = g.style as { width: string; height: string }
    expect(style.width).toBe(`${660 - 80 + GROUP_PADDING * 2}px`)
    expect(style.height).toBe(`${560 - 80 + GROUP_PADDING * 2}px`)
  })

  it('幂等：跑两遍与一遍深等；已完好的画布零扰动', () => {
    const once = restoreGroupHierarchy(persistedScene())
    const twice = restoreGroupHierarchy(once)
    expect(twice).toEqual(once)
    // 已带 parentNode 的完好画布：输出与输入等值（引用可不同，值必须不变）
    const healthy = restoreGroupHierarchy(once)
    expect(healthy.find((n) => n.id === 'img-1')!.parentNode).toBe('group-1')
  })

  it('坏数据容错：childIds 指向不存在节点 / 指向 group 自身时跳过，不抛错', () => {
    const scene = [
      {
        id: 'group-x',
        type: 'group',
        position: { x: 0, y: 0 },
        data: { title: 'g', childIds: ['ghost-1', 'group-x'] },
      },
      { id: 'real-1', type: 'text', position: { x: 10, y: 10 }, data: {} },
    ] as unknown as FlowNode[]
    expect(() => restoreGroupHierarchy(scene)).not.toThrow()
    const g = restoreGroupHierarchy(scene).find((n) => n.id === 'group-x')!
    // 没有有效子节点 → 不做尺寸估算（保持 min-size 兜底），但也不崩
    expect((g.style as { width?: string } | undefined)?.width).toBeUndefined()
  })

  it('无分组的画布直接原样返回', () => {
    const scene = [{ id: 't', type: 'text', position: { x: 0, y: 0 }, data: {} }] as FlowNode[]
    expect(restoreGroupHierarchy(scene)).toBe(scene)
  })
})

describe('syncGroupsToFitChildren：测量后按真实 dimensions 精修', () => {
  it('dimensions 就绪后尺寸按真实包围盒重算', () => {
    const restored = restoreGroupHierarchy(persistedScene())
    const measured = restored.map((n) =>
      n.type === 'image'
        ? { ...n, dimensions: { width: 320, height: 240 } }
        : n,
    ) as FlowNode[]
    const synced = syncGroupsToFitChildren(measured)
    const g = synced.find((n) => n.id === 'group-1')!
    // img-1: 80..400, img-2: 380..700 x 280..520（y: 80+240=320 → maxY=520）
    const style = g.style as { width: string; height: string }
    expect(style.width).toBe(`${700 - 80 + GROUP_PADDING * 2}px`)
    expect(style.height).toBe(`${520 - 80 + GROUP_PADDING * 2}px`)
  })

  it('已贴合（±1px）时返回原数组引用（幂等零抖动）', () => {
    const restored = restoreGroupHierarchy(persistedScene())
    const measured = restored.map((n) =>
      n.type === 'image'
        ? { ...n, dimensions: { width: 320, height: 240 } }
        : n,
    ) as FlowNode[]
    const once = syncGroupsToFitChildren(measured)
    const twice = syncGroupsToFitChildren(once)
    expect(twice).toBe(once)
  })
})
