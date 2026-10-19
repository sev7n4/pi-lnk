// PR2 入口收敛接线契约（2026-10-19 D-2）：
// ① 移动端摘除 NodePanelDock（竖轨）——PC 分支不受影响（!isMobileLayout 与既有
//    !canvasChromeHidden 串联，语义 = 两条件同时满足才渲染，PC 行为逐字不变）；
// ② ＋FAB 只在画布页签 + chrome 未隐藏时出现，呼吸态与空画布联动；
// ③ MobileTopBar 收到任务动态项数据并接线 open-tasks；
// ④ 新建/任务 sheet 的创建/资产/定位/重试全部复用既有处理器（handleDockAdd 等）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')

describe('mobile create-entry convergence wiring (PR2)', () => {
  const page = read('./CanvasPage.vue')

  it('竖轨移动端摘除（v-if 串联 !isMobileLayout）', () => {
    const dock = page.match(/<NodePanelDock\s+v-if="[^"]*"\s+@add="handleDockAdd"[\s\S]*?\/>/)?.[0] ?? ''
    expect(dock, 'NodePanelDock 必须带 !isMobileLayout 门控').toContain('!isMobileLayout')
    expect(dock).toContain('!canvasChromeHidden')
    // PC 处理器原样保留（新建/资产/任务/设置四条 emit 不变）
    expect(dock).toContain('@asset-apply="handleAssetApply"')
    expect(dock).toContain('@history-locate="handleHistoryLocate"')
  })

  it('＋FAB 门控：画布页签 + chrome 未隐藏；呼吸联动空画布', () => {
    expect(page).toMatch(
      /<MobileCanvasCreateFab\s+v-if="isMobileLayout && mobileAppTab === 'canvas' && !canvasChromeHidden"/,
    )
    expect(page).toMatch(/:breathe="!nodes\.length"/)
  })

  it('新建 sheet / 任务 sheet 接线既有处理器', () => {
    expect(page).toContain('<MobileCreateSheet')
    expect(page).toContain('@create="handleMobileCreate"')
    expect(page).toContain('@asset-apply="handleMobileAssetApply"')
    expect(page).toContain('@asset-add-to-agent="handleMobileAssetAddToAgent"')
    expect(page).toContain('<MobileTaskSheet')
    expect(page).toContain('@locate="handleMobileTaskLocate"')
    expect(page).toContain('@retry="handleMobileTaskRetry"')
    // 复用而非重造：mobile 处理器内部调竖轨同一条链路
    const handlers = page.match(/function handleMobileCreate[\s\S]*?function handleMobileTaskRetry[\s\S]*?\n}/)?.[0] ?? ''
    expect(handlers).toContain('handleDockAdd(type)')
    expect(handlers).toContain('handleAssetApply(asset)')
    expect(handlers).toContain('handleAssetAddToAgent(asset)')
    expect(handlers).toContain('handleHistoryLocate(payload)')
    expect(handlers).toContain('handleHistoryRetry(nodeId)')
  })

  it('MobileTopBar 任务动态项数据接线', () => {
    expect(page).toContain(':task-active-count="mobileTaskActiveCount"')
    expect(page).toContain(':has-task-history="mobileTaskHasHistory"')
    expect(page).toContain('@open-tasks="showMobileTaskSheet = true"')
  })

  it('任务计数轮询：画布页签才跑，卸载即停', () => {
    expect(page).toContain('function loadMobileTaskCount')
    expect(page).toContain('function startMobileTaskPolling')
    expect(page).toContain('function stopMobileTaskPolling')
    expect(page).toMatch(/onUnmounted\([\s\S]*?stopMobileTaskPolling\(\)/)
    expect(page).toContain('studioApi.listGenerations({ sessionId: sessionId.value })')
  })

  it('空态引导：画布页签 + 空 nodes 才显示', () => {
    expect(page).toMatch(/v-if="isMobileLayout && mobileAppTab === 'canvas' && !nodes\.length"/)
    expect(page).toContain('data-testid="mobile-canvas-empty"')
    expect(page).toContain('按住底部条说话')
  })
})
