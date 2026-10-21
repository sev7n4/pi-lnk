/**
 * Agent 分组路径的**行为级**守卫（2026-10-21）。
 *
 * ⭐ 为什么必须是行为级而不是源码扫描：
 * 「Agent 建组 → 拿到 group_id → 改色/解组」这条链路上，最致命的一类失效是
 * **id 在某一层被换掉**：Agent 生成了 id A、随命令下发、前端却另生成 id B
 * ⇒ Agent 后续拿着 A 去改色，前端按 B 找组 ⇒ 找不到 ⇒ 静默无效。
 * 源码扫描看不出这种「id 是否同一个」，只有真的跑一遍 `createGroupFromSelection`
 * 看返回的 groupId 是不是传进去的那个，才能证伪。
 *
 * 覆盖：
 *  1. **指定 groupId ⇒ 落库用同一个 id**（Agent 路径的命门）；
 *  2. **不指定 ⇒ 仍走原有生成逻辑**（用户手动路径零行为变化）；
 *  3. **id 撞已有节点 ⇒ 回退自生成**（不能让传入 id 覆盖真实节点 ⇒ 节点凭空消失）；
 *  4. **空串 / 纯空白 id ⇒ 回退自生成**；
 *  5. **指定 id 时子节点的 parentNode 同步为该 id**（框与子节点必须同 id，
 *     否则框建出来是空的、子节点仍是孤儿）。
 */
import { describe, expect, it } from 'vitest'
import { createGroupFromSelection } from './useCanvasGrouping'
import type { FlowNode } from './useCanvasGrouping'

/** 造两个普通节点（type 不是 group）。 */
function baseNodes(): FlowNode[] {
  return [
    { id: 'n1', type: 'image', position: { x: 0, y: 0 }, style: { width: '100px', height: '100px' } },
    { id: 'n2', type: 'image', position: { x: 200, y: 0 }, style: { width: '100px', height: '100px' } },
  ] as unknown as FlowNode[]
}

function groupNodesOf(nodes: FlowNode[]): FlowNode[] {
  return nodes.filter((n) => n.type === 'group')
}

describe('Agent 分组路径：group_id 贯通（行为级）', () => {
  it('⭐ 指定 groupId ⇒ 返回的 groupId 就是它（Agent 后续靠这个 id 改色/解组）', () => {
    const result = createGroupFromSelection(baseNodes(), ['n1', 'n2'], undefined, 'group-agent-xyz')
    expect(result).not.toBeNull()
    expect(result!.groupId).toBe('group-agent-xyz')
  })

  it('⭐ 指定 groupId ⇒ 分组节点的 id 就是它（框真的建在这个 id 上）', () => {
    const result = createGroupFromSelection(baseNodes(), ['n1', 'n2'], undefined, 'group-agent-xyz')
    const g = groupNodesOf(result!.nodes)
    expect(g).toHaveLength(1)
    expect(g[0]!.id).toBe('group-agent-xyz')
  })

  it('⭐ 指定 groupId ⇒ 子节点的 parentNode 同步为该 id（否则框是空的、子节点成孤儿）', () => {
    const result = createGroupFromSelection(baseNodes(), ['n1', 'n2'], undefined, 'group-agent-xyz')
    const kids = result!.nodes.filter((n) => n.id === 'n1' || n.id === 'n2')
    expect(kids).toHaveLength(2)
    for (const k of kids) {
      expect(k.parentNode).toBe('group-agent-xyz')
    }
  })

  it('不指定 groupId ⇒ 仍走原有自生成逻辑（用户手动路径零行为变化）', () => {
    const result = createGroupFromSelection(baseNodes(), ['n1', 'n2'])
    expect(result).not.toBeNull()
    expect(result!.groupId).toMatch(/^group-/)
    expect(result!.groupId).not.toBe('group-')
    // 自生成的 id 与任何传入值无关
    expect(result!.groupId.startsWith('group-')).toBe(true)
  })

  it('id 撞已有节点 ⇒ 回退自生成（不能让传入 id 覆盖真实节点 ⇒ 节点凭空消失）', () => {
    const nodes = baseNodes()
    const result = createGroupFromSelection(nodes, ['n1', 'n2'], undefined, 'n1')
    expect(result).not.toBeNull()
    expect(result!.groupId).not.toBe('n1')
    // 原来的 n1 节点必须还在（没被覆盖掉）
    const n1 = result!.nodes.find((n) => n.id === 'n1')
    expect(n1).toBeDefined()
    expect(n1!.type).toBe('image')
  })

  it('空串 / 纯空白 id ⇒ 回退自生成', () => {
    for (const bad of ['', '   ']) {
      const result = createGroupFromSelection(baseNodes(), ['n1', 'n2'], undefined, bad)
      expect(result).not.toBeNull()
      expect(result!.groupId).not.toBe(bad)
      expect(result!.groupId.startsWith('group-')).toBe(true)
    }
  })

  it('子节点绝对位置不变（框只是让位，不搬东西）——指定 id 也不该破坏', () => {
    const nodes = baseNodes()
    const result = createGroupFromSelection(nodes, ['n1', 'n2'], undefined, 'group-agent-xyz')
    const n1 = result!.nodes.find((n) => n.id === 'n1')!
    const n2 = result!.nodes.find((n) => n.id === 'n2')!
    // 子节点 position 相对父级：绝对位置 = 框左上 + 相对坐标。
    // 框左上 = 子节点包围盒左上 - padding ⇒ 相对坐标 = padding（正数）。
    // 绝对位置不变 ⇒ n1 相对坐标 + n2 相对坐标的差 == 原两节点间距（200）。
    const gap = n2.position.x - n1.position.x
    expect(gap).toBe(200)
    expect(n1.position.x).toBeGreaterThan(0)
    expect(n1.position.y).toBeGreaterThan(0)
  })
})
