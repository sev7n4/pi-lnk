import { describe, expect, it } from 'vitest'
import { computeSnapGuides } from '@lnkpi/shared'
import { buildSnapCandidates, getNodeSize, type FlowNode } from './useCanvasGrouping'

/**
 * 拖拽智能参考线的候选构造（SP-B T9a）。
 *
 * 关键口径：`computeSnapGuides`（@lnkpi/shared）只跳过 `isSelf`，
 * **从不读 `parentId`** ⇒ 全部排除逻辑必须由本文件这一层负责。
 */

function node(
  id: string,
  x: number,
  y: number,
  opts?: { parent?: string; w?: number; h?: number },
): FlowNode {
  return {
    id,
    type: 'image',
    position: { x, y },
    data: {},
    ...(opts?.parent ? { parentNode: opts.parent } : {}),
    ...(opts?.w !== undefined && opts?.h !== undefined
      ? { dimensions: { width: opts.w, height: opts.h } }
      : {}),
  }
}

const ids = (cands: { id: string }[]) => cands.map((c) => c.id)

describe('buildSnapCandidates（拖拽参考线候选构造）', () => {
  it('顶层被拖节点：其他顶层节点仍是候选（回归守卫，禁用 parentNode 相等过滤）', () => {
    // ⛔ 曾经的缺陷：用 `n.parentNode !== dragged.parentNode` 过滤 ⇒ 两侧都是
    // undefined 时把**所有**顶层候选全部丢掉 ⇒ 顶层拖拽静默失去吸附能力。
    const nodes = [
      node('drag', 0, 0),
      node('top-a', 100, 100),
      node('top-b', 400, 100),
    ]
    const cands = buildSnapCandidates(nodes, 'drag')
    expect(ids(cands)).toEqual(['top-a', 'top-b'])
  })

  it('被拖节点自身不在候选里', () => {
    const nodes = [node('drag', 0, 0), node('other', 100, 0)]
    expect(ids(buildSnapCandidates(nodes, 'drag'))).not.toContain('drag')
  })

  it('被拖节点的父节点不在候选里（否则分组与父分组互吸）', () => {
    const nodes = [
      node('parent', 0, 0),
      node('drag', 20, 20, { parent: 'parent' }),
      node('other', 500, 500),
    ]
    const cands = buildSnapCandidates(nodes, 'drag')
    expect(ids(cands)).toContain('other')
    expect(ids(cands)).not.toContain('parent')
  })

  it('被拖节点自己的子节点不在候选里（它们随组一起动，是移动目标而非吸附目标）', () => {
    const nodes = [
      node('group', 0, 0),
      node('kid-1', 20, 20, { parent: 'group' }),
      node('kid-2', 200, 20, { parent: 'group' }),
      node('other', 800, 800),
    ]
    const cands = buildSnapCandidates(nodes, 'group')
    expect(ids(cands)).toEqual(['other'])
  })

  it('被拖【子节点】的同父兄弟仍在候选里（合法的固定对齐目标）', () => {
    // 只排除被拖节点**自己的**子节点；同父兄弟是合法候选。
    const nodes = [
      node('group', 0, 0),
      node('drag', 20, 20, { parent: 'group' }),
      node('sibling', 300, 20, { parent: 'group' }),
      node('other', 800, 800),
    ]
    const cands = buildSnapCandidates(nodes, 'drag')
    expect(ids(cands)).toContain('sibling')
    expect(ids(cands)).toContain('other')
    expect(ids(cands)).not.toContain('group')
    expect(ids(cands)).not.toContain('drag')
  })

  it('候选 box 用 flow 坐标 + getNodeSize 尺寸，且 isSelf=false / 带上 parentId', () => {
    const nodes = [
      node('drag', 0, 0),
      node('kid', 30, 40, { parent: 'group', w: 111, h: 222 }),
    ]
    const cands = buildSnapCandidates(nodes, 'drag')
    const kid = cands.find((c) => c.id === 'kid')!
    expect(kid.box).toEqual({ x: 30, y: 40, w: 111, h: 222 })
    expect(kid.isSelf).toBe(false)
    expect(kid.parentId).toBe('group')
  })

  it('opts.bounds 视口裁剪：相交保留、不相交丢弃（规格 §9 性能护栏）', () => {
    const nodes = [
      node('drag', 0, 0),
      node('inside', 100, 100, { w: 50, h: 50 }),
      node('outside', 5000, 5000, { w: 50, h: 50 }),
    ]
    const cands = buildSnapCandidates(nodes, 'drag', { bounds: { x: 0, y: 0, w: 500, h: 500 } })
    expect(ids(cands)).toEqual(['inside'])
  })

  it('没有 bounds 时不做任何裁剪（全部合法候选都返回）', () => {
    const nodes = [node('drag', 0, 0), node('far', 9999, 9999)]
    expect(ids(buildSnapCandidates(nodes, 'drag'))).toEqual(['far'])
  })
})

// ══════════════════════════════════════════════════════
// SP-B R1（2026-10-23）：sizeOf 实测尺寸注入
// ══════════════════════════════════════════════════════
describe('buildSnapCandidates：sizeOf 实测尺寸注入', () => {
  const videoNode = (x: number, y: number): FlowNode =>
    ({ id: 'v', type: 'video', position: { x, y }, data: {} }) as FlowNode

  it('⛔ 回归：媒体节点按实测盒进候选，不再按 NODE_SIZES 方框兜底', () => {
    // 16:9 视频真实 320×180；兜底方框 320×320 ⇒ 底边/中心差 140/70px：
    // 节点视觉边没贴线就被弹回、guide 线悬在节点旁（用户实测「步阶太大」的几何根因）。
    const nodes = [node('drag', 0, 300), videoNode(0, 0)]
    const sizeOf = (n: FlowNode) => (n.id === 'v' ? { w: 320, h: 180 } : getNodeSize(n))
    expect(
      buildSnapCandidates(nodes, 'drag', { sizeOf }).find((c) => c.id === 'v')!.box,
      '候选盒取实测 320×180',
    ).toEqual({ x: 0, y: 0, w: 320, h: 180 })
    expect(
      buildSnapCandidates(nodes, 'drag').find((c) => c.id === 'v')!.box,
      '不传 sizeOf 时维持 getNodeSize 兜底（320×320 方框）',
    ).toEqual({ x: 0, y: 0, w: 320, h: 320 })
  })

  it('实测盒决定命中：视频实测中心命中被拖 text 中心，兜底方框则不命中', () => {
    // 被拖 text 280×160 @ (0,300) ⇒ centerY = 380
    const nodes = [node('drag', 0, 300, { w: 280, h: 160 }), videoNode(0, 290)]
    const sizeOf = (n: FlowNode) => (n.id === 'v' ? { w: 320, h: 180 } : getNodeSize(n))
    const hit = computeSnapGuides(
      { x: 0, y: 300, w: 280, h: 160 },
      buildSnapCandidates(nodes, 'drag', { sizeOf }),
    )
    expect(hit.horizontal?.position, '视频实测中心 290+90=380 = text 中心 380').toBe(380)

    const fallback = computeSnapGuides(
      { x: 0, y: 300, w: 280, h: 160 },
      buildSnapCandidates(nodes, 'drag'),
    )
    expect(fallback.horizontal, '兜底方框中心 290+160=450 差 70 ⇒ 不命中').toBeUndefined()
  })
})
