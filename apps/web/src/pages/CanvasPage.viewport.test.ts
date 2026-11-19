import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 静态契约层：CanvasPage 是 5000+ 行、依赖 api/store/路由的页面组件，挂载测不现实。
// 视口读写的行为级守卫在 `useCanvasViewport.test.ts`（注入假 setViewport / 落库回调断言出口）。
// 这里只锁住「CanvasPage 有没有把这条链接上、以及回合末有没有被改回全览」。
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'CanvasPage.vue'), 'utf8')

describe('SP-C：CanvasPage 视口接线（静态契约）', () => {
  it('N3：回合末不得出现无条件的全览 fitView —— 每个 fitView 必须 nodes 定向', () => {
    const allFitView = source.match(/fitView\(/g) ?? []
    const nodesScoped = source.match(/fitView\(\{\s*nodes:/g) ?? []
    expect(allFitView.length).toBeGreaterThan(0)
    // 2026-11-19：⤢ 手动桥也改为确定性 restoreContentViewport（裸 fitView 会把
    // 千万级离群节点算进包围盒，zoom 压到 minZoom 0.1，真实内容推出屏幕外——
    // 生产实证"点了没用"）。因此 fitView 只允许 nodes 定向一种形态。
    expect(nodesScoped.length, '所有 fitView 都必须 nodes 定向').toBe(allFitView.length)
  })

  it('init：fit-view-on-init 必须摘除——它对全部节点（含离群）fitView，会覆盖恢复出的健康视口', () => {
    // 生产实证：修复视口落库后，探针访问一次即被 fit-view-on-init 回流成 {zoom:0.1}。
    expect(source).not.toContain('fit-view-on-init')
  })

  it('N3：SP-B 时期那句无条件全览已删除（防回归，逐字）', () => {
    expect(source).not.toContain('fitView({ padding: 0.24')
  })

  it('采集：VueFlow 挂上了 viewport-change 事件', () => {
    expect(source).toContain('@viewport-change="onViewportChange"')
  })

  it('落库：saveCanvas 把当前视口交给 extrasForCanvasSave（可选键，N1）', () => {
    expect(source).toContain('viewport: viewportTracker.pending')
  })

  it('恢复：loadSession 在 nodes 应用完之后恢复视口（R5 时序）', () => {
    expect(source).toContain('restoreViewport(serverViewport)')
    // 恢复必须排在 nodes 应用之后：否则内容还没进测量盒，setViewport 没有意义
    expect(source.indexOf('restoreViewport(serverViewport)')).toBeGreaterThan(
      source.indexOf('applyGroupDraggable(isMobileLayout.value)'),
    )
  })

  it('恢复：脏/缺落库视口 ⇒ 统一走确定性 restoreContentViewport（不依赖 fitView 测量）', () => {
    // fitView({nodes}) 在 loadSession 的 nextTick 窗口内没有节点测量盒，生产实证不生效；
    // 兜底必须由 computeContentViewport 算出确定性视口，再 setViewport 落位。
    // 恢复失败（脏视口）与无落库视口（存量画布）都落到同一确定性路径。
    expect(source).toContain('const restored = serverViewport ? restoreViewport(serverViewport) : false')
    expect(source).toContain('if (!restored) restoreContentViewport()')
    expect(source).toContain('computeContentViewport(')
    expect(source).toContain('setViewport?.(safeViewport, { duration: 0 })')
  })

  it('⤢ 手动桥：委托 restoreContentViewport，不得再裸调 VueFlow fitView', () => {
    expect(source).toContain('fitView: () => restoreContentViewport()')
    expect(source).not.toContain('fitView({ padding: 0.2')
  })

  it('视口逻辑走抽出的 composable（不在页面里手写防抖/clamp）', () => {
    expect(source).toContain("from '@/composables/useCanvasViewport'")
  })
})
