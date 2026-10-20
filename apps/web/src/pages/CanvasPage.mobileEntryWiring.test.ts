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

/** 剥注释后再定位调用位置——注释里出现函数名会让 indexOf 命中叙述文本而非代码
 *  （迁移说明写进注释是本仓规范，全文扫描断言必假红）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}

describe('mobile create-entry convergence wiring (PR2)', () => {
  const page = read('./CanvasPage.vue')
  // PR5（D-9）：＋FAB / 新建·任务 sheet / 任务轮询 / MobileTopBar 任务动态项接线迁入
  // MobileCanvasShell，相关断言改读壳层源码。
  const shell = read('../components/mobile/MobileCanvasShell.vue')

  it('竖轨移动端摘除（v-if 串联 !isMobileLayout）', () => {
    const dock = page.match(/<NodePanelDock\s+v-if="[^"]*"\s+@add="handleDockAdd"[\s\S]*?\/>/)?.[0] ?? ''
    expect(dock, 'NodePanelDock 必须带 !isMobileLayout 门控').toContain('!isMobileLayout')
    expect(dock).toContain('!canvasChromeHidden')
    // PC 处理器原样保留（新建/资产/任务/设置四条 emit 不变）
    expect(dock).toContain('@asset-apply="handleAssetApply"')
    expect(dock).toContain('@history-locate="handleHistoryLocate"')
  })

  it('＋FAB 门控：画布页签 + chrome 未隐藏；呼吸联动空画布；多选态让位给动作条', () => {
    // PR5（D-9）：＋FAB 迁入 MobileCanvasShell（壳层仅移动端渲染，v-if 不带 isMobileLayout）
    // 2026-10-20 真机走查：多选态须让位给多选动作条（同一底部清位，与状态行同一规则）
    expect(shell).toMatch(
      /<MobileCanvasCreateFab\s+v-if="mobileAppTab === 'canvas' && !canvasChromeHidden && !multiSelectActive"/,
    )
    expect(shell).toMatch(/:breathe="!hasNodes"/)
  })

  it('新建 sheet / 任务 sheet 接线既有处理器', () => {
    // PR5（D-9）：两 sheet 迁入 MobileCanvasShell，处理器经 props 复用而非重造
    expect(shell).toContain('<MobileCreateSheet')
    expect(shell).toContain('@create="onMobileCreate"')
    expect(shell).toContain('@asset-apply="onMobileAssetApply"')
    expect(shell).toContain('@asset-add-to-agent="onMobileAssetAddToAgent"')
    expect(shell).toContain('<MobileTaskSheet')
    expect(shell).toContain('@locate="onMobileTaskLocate"')
    expect(shell).toContain('@retry="onMobileTaskRetry"')
    // 复用而非重造：壳层处理器内部调 CanvasPage 同一条链路（经 props 下发）
    const handlers = shell.match(/function onMobileCreate[\s\S]*?function onMobileTaskRetry[\s\S]*?\n}/)?.[0] ?? ''
    expect(handlers).toContain('props.dockAdd(type)')
    expect(handlers).toContain('props.assetApply(asset)')
    expect(handlers).toContain('props.assetAddToAgent(asset)')
    expect(handlers).toContain('props.historyLocate(payload)')
    expect(handlers).toContain('props.historyRetry(nodeId)')
  })

  it('MobileTopBar 任务动态项数据接线', () => {
    // PR5（D-9）：任务动态项数据接线随 MobileTopBar 迁入 MobileCanvasShell
    expect(shell).toContain(':task-active-count="mobileTaskActiveCount"')
    expect(shell).toContain(':has-task-history="mobileTaskHasHistory"')
    expect(shell).toContain('@open-tasks="showMobileTaskSheet = true"')
  })

  it('任务计数轮询：画布页签才跑，卸载即停', () => {
    // PR5（D-9）：轮询逻辑迁入 MobileCanvasShell
    expect(shell).toContain('function loadMobileTaskCount')
    expect(shell).toContain('function startMobileTaskPolling')
    expect(shell).toContain('function stopMobileTaskPolling')
    expect(shell).toMatch(/onUnmounted\([\s\S]*?stopMobileTaskPolling\(\)/)
    expect(shell).toContain('studioApi.listGenerations({ sessionId: props.sessionId })')
  })

  it('发现页「资料库」：切页签后须等 nextTick 再展开资产库（选择器挂在 composer 面板内）', () => {
    // 资产库选择器挂在 composer 面板内 ⇒ 面板随页签切换重渲染后才可展开。
    // 漏掉 nextTick 会让 openAssetLibrary 打在旧树上（静默失效，不报错）。
    const handler = stripComments(
      shell.match(/async function onDiscoverGotoCanvas[\s\S]*?\n}/)?.[0] ?? '',
    )
    expect(handler, '壳层必须提供 onDiscoverGotoCanvas').toContain('await nextTick()')
    const tickAt = handler.indexOf('await nextTick()')
    const openAt = handler.indexOf('props.agentActions.openAssetLibrary')
    expect(tickAt, '必须先 await nextTick').toBeGreaterThan(-1)
    expect(openAt, '展开资产库必须排在 nextTick 之后').toBeGreaterThan(tickAt)
    // 有效性配对：确实调到了 openAssetLibrary（防 indexOf=-1 假绿）
    expect(openAt).toBeGreaterThan(-1)
  })

  it('空态引导：画布页签 + 空 nodes 才显示', () => {
    expect(page).toMatch(/v-if="isMobileLayout && mobileAppTab === 'canvas' && !nodes\.length"/)
    expect(page).toContain('data-testid="mobile-canvas-empty"')
    expect(page).toContain('按住底部条说话')
  })
})
