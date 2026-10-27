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
  it('N3：回合末不得出现无条件的全览 fitView —— 每个 fitView 要么 nodes 定向，要么是 ⤢ 手动桥', () => {
    const allFitView = source.match(/fitView\(/g) ?? []
    const nodesScoped = source.match(/fitView\(\{\s*nodes:/g) ?? []
    // 2026-10-27 三页顶栏重构 §6.3：⤢ 适应画布从浮动胶囊上提到顶栏，经 agentRailActions
    // 桥接 VueFlow——这是**用户显式动作**，不属于「回合末自动全览」的禁域。标记注释
    // `/* ⤢ 手动桥（N3 例外）` 是唯一豁免凭据；新增任何无标记的无条件 fitView ⇒ 红。
    const manualBridge = source.match(/\/\* ⤢ 手动桥（N3 例外）/g) ?? []
    expect(allFitView.length).toBeGreaterThan(0)
    expect(manualBridge.length, '⤢ 手动桥标记必须恰好一处（多了=有人夹带无标记全览）').toBe(1)
    expect(nodesScoped.length + manualBridge.length).toBe(allFitView.length)
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

  it('视口逻辑走抽出的 composable（不在页面里手写防抖/clamp）', () => {
    expect(source).toContain("from '@/composables/useCanvasViewport'")
  })
})
