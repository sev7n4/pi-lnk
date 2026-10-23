/**
 * SP-B 拖拽智能参考线 —— CanvasPage 接线（T9b）。
 *
 * 本文件锁两件事：
 *
 * 1. **接线形态**（静态断言 .vue 源码，判据形式沿用 CanvasPage.groupResize.test.ts
 *    的「函数体提取 + 静态断言」）。页面级 SFC 在 vitest 里直接 import 会超时
 *    （实测 environment 29s / 整文件 45s），故此处不做挂载，改锁源码结构 ——
 *    这几条恰好都是「写错了但静默失效」的根因：
 *    - ⛔ 候选必须走 buildSnapCandidates（内联 parentNode 过滤会吃掉全部顶层候选）；
 *    - ⛔ guide 状态必须带 sourceNodeId（存裸数字 ⇒ hysteresis 永不触发 ⇒ 线闪）；
 *    - ⛔ 多选拖拽只按锚点算一次、整批同移（逐节点各算各的 ⇒ 相对阵列被扯散）；
 *    - ⛔ GuideLines 必须挂在 #zoom-pane（变换容器内）且只传 flow 坐标。
 *
 * 2. **接线所依赖的纯语义**（真跑 computeSnapGuides / buildSnapCandidates）：
 *    批内同移保住相对阵列、`prev` 必须是对象形状、候选盒必须归一到 flow 绝对坐标、
 *    guide 线与节点边在任意 zoom 下投影到同一屏幕位置。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSnapGuides } from '@lnkpi/shared'
import { buildSnapCandidates, type FlowNode } from '@/composables/useCanvasGrouping'

const HERE = dirname(fileURLToPath(import.meta.url))

function pageSource(): string {
  return readFileSync(join(HERE, 'CanvasPage.vue'), 'utf8')
}

/** 截出某个函数的函数体（到下一个顶层 `function ` / `const ` 为止）。 */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `CanvasPage 里找不到 ${signature}`).toBeGreaterThan(0)
  const rest = src.slice(start + signature.length)
  const end = rest.search(/\n(?:function |const |watch\(|provide\()/m)
  return src.slice(start, end > 0 ? start + signature.length + end : undefined)
}

function flowNode(id: string, x: number, y: number, opts?: { parent?: string; w?: number; h?: number }): FlowNode {
  return {
    id,
    type: 'image',
    position: { x, y },
    data: {},
    ...(opts?.parent ? { parentNode: opts.parent } : {}),
    ...(opts?.w !== undefined && opts?.h !== undefined ? { dimensions: { width: opts.w, height: opts.h } } : {}),
  }
}

// ══════════════════════════════════════════════════════════
// 一、接线形态（静态）
// ══════════════════════════════════════════════════════════

describe('SP-B 参考线：CanvasPage 接线', () => {
  it('⛔ 候选构造走 buildSnapCandidates，页面不内联 parentNode 过滤', () => {
    const body = functionBody(pageSource(), 'function computeDragSnapGuides(')
    expect(body, '候选必须由 buildSnapCandidates 构造').toContain('buildSnapCandidates(')
    expect(body, '吸附几何必须由 shared 的 computeSnapGuides 出').toContain('computeSnapGuides(')
    // 曾经的缺陷：`n.parentNode !== <被拖节点 parent>` 内联过滤，两侧都是 undefined
    // 时把**所有**顶层候选全部丢掉 ⇒ 顶层拖拽静默失去吸附能力。
    expect(body, '不得内联 parentNode 相等/不等过滤').not.toMatch(/parentNode\s*!==/)
    expect(body, '不得自己按 id 过滤候选（那是 buildSnapCandidates 的职责）').not.toMatch(/\.filter\(\s*\(?\w+\)?\s*=>\s*\w+\.id\s*!==/)
  })

  it('⛔ guide 状态带 sourceNodeId（存裸数字会让 hysteresis 永不触发）', () => {
    const src = pageSource()
    // 状态声明用 shared 的 SnapPrev（position + sourceNodeId 双字段）
    expect(src).toMatch(/const snapGuides = ref<SnapPrev>\(\{\}\)/)
    // 落值时两个朝向都补齐 sourceNodeId
    const body = functionBody(pageSource(), 'function computeDragSnapGuides(')
    expect(body).toMatch(/guides\.horizontal = \{ position: res\.horizontal\.position, sourceNodeId: res\.horizontal\.sourceNodeId \}/)
    expect(body).toMatch(/guides\.vertical = \{ position: res\.vertical\.position, sourceNodeId: res\.vertical\.sourceNodeId \}/)
    // prev 传的是这份对象状态（读 prev.<朝向>.position）
    expect(body).toMatch(/prev: snapGuides\.value/)
  })

  it('⛔ 多选拖拽只按锚点算一次，整批同移同一 delta（相对阵列不变）', () => {
    const body = functionBody(pageSource(), 'function onNodesChange(')
    // 一次 tick 只算一次吸附量（锚点），绝不按 change.id 逐节点算
    const calls = body.match(/computeDragSnapGuides\(/g) ?? []
    expect(calls, 'onNodesChange 里只能有一处 computeDragSnapGuides 调用').toHaveLength(1)
    expect(body, '吸附只认锚点').toMatch(/if \(dragAnchorId && draggedIds\.has\(dragAnchorId\)\)/)
    // 同一 dx/dy 平移给批内每个节点
    expect(body).toMatch(
      /draggedIds\.has\(node\.id\)\s*\?\s*\{ \.\.\.node, position: \{ x: node\.position\.x \+ dx, y: node\.position\.y \+ dy \} \}/,
    )
    // 本批 position 变更里属于拖拽批的 id 才会被平移
    expect(body, '只平移拖拽批内节点').toMatch(/if \(dragStartPositions\.has\(change\.id\)\) draggedIds\.add\(change\.id\)/)
  })

  it('⛔ 拖拽开始重置 guide 状态；拖拽结束参考线优先于 20px 网格', () => {
    const src = pageSource()
    const start = functionBody(pageSource(), 'function onNodeDragStart(')
    expect(start, '新一轮拖拽必须清空上一轮的 guide 命中').toMatch(/snapGuides\.value = \{\}/)
    expect(start, '锚点取 vue-flow 事件的主节点（拖不动时退回批内首个）').toMatch(
      /dragAnchorId = event\.node\?\.id \?\? dragStartPositions\.keys\(\)\.next\(\)\.value \?\? null/,
    )

    const stop = functionBody(src, 'function onNodeDragStop(')
    expect(stop, '必须判本次拖拽是否有 guide 命中').toMatch(
      /const hadGuide = snapGuides\.value\.horizontal != null \|\| snapGuides\.value\.vertical != null/,
    )
    // 参考线与网格不叠加（规格 D3）
    expect(stop, '有 guide 命中时必须跳过 applySnapOnRelease').toMatch(
      /if \(viewportSettings\.value\.snapToGrid && dragStartPositions\.size > 0 && !hadGuide\) \{/,
    )
    // 无 guide 命中时网格吸附原样保留
    expect(stop).toContain('applySnapOnRelease(')
    expect(stop, '松手后清空 guide 状态').toMatch(/snapGuides\.value = \{\}/)
  })

  it('⛔ GuideLines 挂在 #zoom-pane 内、只收 flow 坐标（缩放无关）', () => {
    const src = pageSource()
    const slot = src.indexOf('<template #zoom-pane>')
    expect(slot, 'GuideLines 必须挂在 vue-flow 的变换容器（#zoom-pane）内').toBeGreaterThan(0)
    const guide = src.indexOf('<GuideLines', slot)
    expect(guide, '#zoom-pane 槽里必须有 GuideLines').toBeGreaterThan(0)
    const close = src.indexOf('</template>', guide)
    expect(close, 'GuideLines 必须落在 #zoom-pane 槽内').toBeGreaterThan(0)
    expect(src.slice(slot, close)).toContain(':horizontal="snapGuides.horizontal?.position"')
    expect(src.slice(slot, close)).toContain(':vertical="snapGuides.vertical?.position"')
    // 组件收的是裸数字（.position），页面侧只做解包，不做 flow→screen 换算
    // 负向断言只覆盖 GuideLines 标签本身：slot 区间必然含槽名 "#zoom-pane"（含 "zoom"），
    // 把它算进来会让本断言永不可能成立（测试自身的区间选取缺陷，与实现无关）。
    expect(src.slice(guide, close)).not.toMatch(/getViewport|zoom|translate\(/)
  })

  it('视口裁剪：候选按当前视口四至 + 边距裁剪（规格 §9 性能护栏）', () => {
    const src = pageSource()
    expect(functionBody(src, 'function computeDragSnapGuides(')).toMatch(/bounds: snapViewportBounds\(\)/)
    const bounds = functionBody(pageSource(), 'function snapViewportBounds(')
    // flow = (screen - translate) / zoom：屏幕左上角反投影回 flow 坐标
    expect(bounds).toMatch(/x: -vp\.x \/ zoom - SNAP_VIEWPORT_MARGIN/)
    expect(bounds).toMatch(/y: -vp\.y \/ zoom - SNAP_VIEWPORT_MARGIN/)
    expect(bounds).toMatch(/w: \(rect\?\.width \|\| 1000\) \/ zoom \+ SNAP_VIEWPORT_MARGIN \* 2/)
  })

  it('候选盒归一到 flow 绝对坐标（分组子节点的 position 是父相对）', () => {
    const body = functionBody(pageSource(), 'function computeDragSnapGuides(')
    expect(body, '候选列表必须先归一到绝对坐标').toMatch(
      /const absNodes: FlowNode\[\] = flow\.map\(\(n\) => \(\{ \.\.\.n, position: getAbsolutePosition\(n, flow\) \}\)\)/,
    )
    expect(body, '被拖节点的包围盒也取绝对坐标').toContain('getAbsolutePosition(anchor, flow)')
  })

  // ── R1（2026-10-23 实测反馈平滑化）接线断言 ──
  it('⛔ R1：onNodesChange 接住 dimensions 变更进 measuredNodeSizes', () => {
    const body = functionBody(pageSource(), 'function onNodesChange(')
    // vue-flow ResizeObserver 实测通道：旧实现整条丢弃 ⇒ getNodeSize 永远走
    // NODE_SIZES 方框兜底 ⇒ 16:9 媒体节点吸附几何差 70-140px
    expect(body, '必须处理 dimensions 变更').toMatch(/change\.type === 'dimensions'/)
    expect(body, '实测尺寸写入 measuredNodeSizes').toMatch(/measuredNodeSizes\.set\(change\.id/)
  })

  it('⛔ R1：吸附阈值按 1/zoom 换算（屏幕空间手感），锚点盒走 snapSizeOf', () => {
    const body = functionBody(pageSource(), 'function computeDragSnapGuides(')
    expect(body, '锚点盒尺寸走 snapSizeOf（实测优先，不再 getNodeSize 直出）').toMatch(
      /const size = snapSizeOf\(anchor\)/,
    )
    expect(body, '半径 = 屏幕空间 8px / zoom').toMatch(/snapRadius: SNAP_SCREEN_RADIUS \/ zoom/)
    expect(body, '迟滞 = 屏幕空间 3px / zoom').toMatch(/hysteresis: SNAP_SCREEN_HYSTERESIS \/ zoom/)
    expect(body, '候选注入 sizeOf（实测尺寸）').toMatch(/sizeOf: snapSizeOf/)
  })

  it('⛔ R1：snapSizeOf 尺寸解析链 = 实测 > 分组框 style > NODE_SIZES 兜底', () => {
    const body = functionBody(pageSource(), 'function snapSizeOf(')
    expect(body, '实测优先').toMatch(/measuredNodeSizes\.get\(node\.id\)/)
    expect(body, '分组框走 groupNodeSize（style 权威）').toMatch(/isGroupNode\(node\)[\s\S]*groupNodeSize\(node\)/)
    expect(body, '兜底 getNodeSize').toMatch(/getNodeSize\(node\)/)
  })

  it('⛔ R1：视口边界拖拽中缓存（zoom 不变直接返回），每次拖拽开始作废', () => {
    const bounds = functionBody(pageSource(), 'function snapViewportBounds(')
    expect(bounds, 'zoom 不变走缓存（免每帧 getBoundingClientRect 强布局）').toMatch(
      /if \(snapBoundsCache && zoom === snapBoundsZoom\) return snapBoundsCache/,
    )
    const start = functionBody(pageSource(), 'function onNodeDragStart(')
    expect(start, '新一轮拖拽作废视口缓存（两次拖拽间可能平移/缩放过）').toMatch(/snapBoundsCache = undefined/)
  })
})

// ══════════════════════════════════════════════════════════
// 二、接线所依赖的纯语义（真跑 shared / web 的纯函数）
// ══════════════════════════════════════════════════════════

describe('SP-B 参考线：批内同移与 prev 形状（接线依赖的纯语义）', () => {
  // 候选：box {0,0,200,100} ⇒ 垂直锚 left=0 / right=200 / centerX=100
  const cands = buildSnapCandidates([flowNode('anchor', 9, 500, { w: 200, h: 100 }), flowNode('cand', 0, 0, { w: 200, h: 100 })], 'anchor')

  it('prev 是对象形状时：hysteresis 释放带（radius+0.5）内保持上一条线（不闪）', () => {
    const within = { x: 8.2, y: 500, w: 200, h: 100 } // 距候选左边 8.2px：>radius(8) 但 ≤8.5
    const res = computeSnapGuides(within, cands, { prev: { vertical: { position: 0, sourceNodeId: 'cand' } } })
    expect(res.vertical, '释放带内应保留原线').toEqual({ position: 0, sourceNodeId: 'cand' })
    expect(res.snapped.x, '吸附后左边贴到候选左边').toBe(0)
  })

  it('⛔ R1 回归：prev 线离开释放带必须脱钩（旧实现无限粘滞 = 实测「被吸住」）', () => {
    // 旧实现对 prev 配对不设距离上限 ⇒ 吸上后拖到哪都粘着，只有别的线更近才顶掉。
    const beyond = { x: 9, y: 500, w: 200, h: 100 } // 距候选左边 9px > 8.5 释放带
    const res = computeSnapGuides(beyond, cands, { prev: { vertical: { position: 0, sourceNodeId: 'cand' } } })
    expect(res.vertical, '超出释放带不得再粘住').toBeUndefined()
    expect(res.snapped.x, '脱钩后节点自由跟手').toBe(9)
  })

  it('⛔ prev 若退化成裸数字：同一帧就丢线（这正是必须存 sourceNodeId 的原因）', () => {
    const dragBox = { x: 9, y: 500, w: 200, h: 100 }
    // 复刻「prev 存数字」的形状：computeSnapGuides 读 prev.vertical.position → undefined
    const res = computeSnapGuides(dragBox, cands, { prev: { vertical: 0 } as never })
    expect(res.vertical, '数字形状读不出 position ⇒ keepPrev 永不触发 ⇒ 线消失').toBeUndefined()
    expect(res.snapped.x, '没保持住原线，节点不被拉回').toBe(9)
  })

  it('多选拖拽：锚点算一次 delta、整批同移 ⇒ 相对阵列逐项不变', () => {
    // 候选必须在半径内（8px）才命中 ⇒ 用 5px 偏移（9px 已在半径外，测不出吸附）
    const list = [flowNode('anchor', 5, 500, { w: 200, h: 100 }), flowNode('b', 405, 500, { w: 200, h: 100 }), flowNode('c', 805, 500, { w: 200, h: 100 })]
    const dragIds = new Set(list.map((n) => n.id))
    const xsBefore = list.map((n) => n.position.x)

    // 页面同款接线：只按锚点算一次（候选里要有近处的参照节点）
    const scene = [...list, flowNode('cand', 0, 0, { w: 200, h: 100 })]
    const absAnchor = { x: 5, y: 500 }
    const res = computeSnapGuides({ ...absAnchor, w: 200, h: 100 }, buildSnapCandidates(scene, 'anchor'), { prev: {} })
    const dx = res.snapped.x - absAnchor.x
    const dy = res.snapped.y - absAnchor.y
    expect(dx, '锚点左边距候选左边 5px ⇒ 拉回 -5').toBe(-5)

    const after = list.map((n) => (dragIds.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n))
    const gap = (xs: number[], i: number) => xs[i] - xs[i - 1]
    expect(gap(after.map((n) => n.position.x), 1), '批内间距不变').toBe(gap(xsBefore, 1))
    expect(gap(after.map((n) => n.position.x), 2), '批内间距不变').toBe(gap(xsBefore, 2))
    expect(after.map((n) => n.position.x)).toEqual([0, 400, 800])
    // 若逐节点各算各的，b/c 的候选集会含彼此，间距必被拉歪 —— 这里锁住的是「整批同移」
    expect(new Set(after.map((n) => n.position.y))).toEqual(new Set([500]))
  })
})

describe('SP-B 参考线：坐标归一与缩放无关（guide 线与节点边同源）', () => {
  it('候选盒归一到绝对坐标后，同组兄弟才是合法候选（否则差一个父偏移）', () => {
    // 分组 g 在 (1000, 1000)；两个子节点 position 是**父相对**坐标
    // childA 相对 (90,300) ⇒ 绝对 (1090,1300)，底边 1400 正好贴住 childB 的上边 1400
    const raw: FlowNode[] = [
      flowNode('g', 1000, 1000, { w: 600, h: 600 }),
      flowNode('childA', 90, 300, { parent: 'g', w: 200, h: 100 }),
      flowNode('childB', 90, 400, { parent: 'g', w: 200, h: 100 }),
    ]
    const abs = raw.map((n) => ({ ...n, position: absPos(n, raw) }))

    // 被拖 childA（绝对 1090,1090）；命中 childB 的上边 y=1400
    const a = abs.find((n) => n.id === 'childA')!
    const withAbs = computeSnapGuides({ x: a.position.x, y: a.position.y, w: 200, h: 100 }, buildSnapCandidates(abs, 'childA'), { prev: {} })
    expect(withAbs.horizontal?.position, 'guide 线的 y 必须落在候选的 flow 绝对坐标上').toBe(1400)

    // ⛔ 若不归一（直接把父相对 position 当 flow 坐标喂进去），guide 会落在 400
    const aRaw = raw.find((n) => n.id === 'childA')!
    const withRaw = computeSnapGuides({ x: aRaw.position.x, y: aRaw.position.y, w: 200, h: 100 }, buildSnapCandidates(raw, 'childA'), { prev: {} })
    expect(withRaw.horizontal?.position, '未归一时 guide 落点错位一个父偏移').toBe(400)
    expect(withRaw.horizontal?.position).not.toBe(withAbs.horizontal?.position)
  })

  it('guide 线与被拖节点边同处 flow 坐标 ⇒ 任意 zoom/pan 投影后仍在同一屏幕位置', () => {
    const list = [flowNode('anchor', 5, 500, { w: 200, h: 100 }), flowNode('cand', 0, 0, { w: 200, h: 100 })]
    const res = computeSnapGuides({ x: 5, y: 500, w: 200, h: 100 }, buildSnapCandidates(list, 'anchor'), { prev: {} })
    const guideFlowX = res.vertical!.position
    const nodeEdgeFlowX = res.snapped.x // 吸附后锚点左边 == guide 线所在 flow x

    // 两者都在变换容器内：screen = flow * zoom + translate
    for (const { zoom, tx } of [
      { zoom: 0.5, tx: -120 },
      { zoom: 1, tx: 0 },
      { zoom: 2, tx: 340 },
    ]) {
      expect(guideFlowX * zoom + tx).toBe(nodeEdgeFlowX * zoom + tx)
    }
  })

  it('guide 线取的是候选节点的锚点位置（不是被拖节点自己的位置）', () => {
    const res = computeSnapGuides(
      { x: 309, y: 500, w: 200, h: 100 },
      buildSnapCandidates([flowNode('anchor', 309, 500, { w: 200, h: 100 }), flowNode('cand', 100, 0, { w: 200, h: 100 })], 'anchor'),
      { prev: {} },
    )
    // 候选左边 100；被拖锚点左边 309 → 距离 209 > 8，不该命中
    expect(res.vertical).toBeUndefined()
    const near = computeSnapGuides(
      { x: 105, y: 500, w: 200, h: 100 },
      buildSnapCandidates([flowNode('anchor', 105, 500, { w: 200, h: 100 }), flowNode('cand', 100, 0, { w: 200, h: 100 })], 'anchor'),
      { prev: {} },
    )
    expect(near.vertical).toEqual({ position: 100, sourceNodeId: 'cand' })
  })
})

/** 与 useCanvasGrouping.getAbsolutePosition 同口径的最小实现（本文件只用于造数）。 */
function absPos(node: FlowNode, nodes: FlowNode[]): { x: number; y: number } {
  let { x, y } = node.position
  let parentId = node.parentNode
  while (parentId) {
    const parent = nodes.find((n) => n.id === parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentNode
  }
  return { x, y }
}