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
    // 2026-10-21 真机走查：dock 展开时也须让位（dock 面板占满画布底部，FAB 会压其左下角）；
    // 窗态（composer 可见）也不出——由 composer 盖住这一带（48=48 无位移余量）
    // 用「先切出标签块再逐条断言」而非一条大正则：v-if 条件跨行书写，末尾换行会让
    // 紧邻引号的正则假红（判据：本仓模板条件一律换行书写）。
    const fabTag = shell.match(/<MobileCanvasCreateFab[\s\S]*?\/>/)?.[0] ?? ''
    expect(fabTag, '必须能定位 ＋FAB 开标签').toContain('<MobileCanvasCreateFab')
    for (const cond of [
      "mobileAppTab === 'canvas'",
      '!canvasChromeHidden',
      '!multiSelectActive',
      '!dockExpanded',
      '!composerVisible',
    ]) {
      expect(fabTag, `＋FAB 门控须含 ${cond}`).toContain(cond)
    }
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

  it('IA v4：发现页不再有「资料库」行，资产库改由画布页 composer 附件卡直达', () => {
    // 2026-10-23 IA v4：发现页签改承载社区/分享（DiscoverPane 社区化），
    // 「资料库」跨页签入口随之撤除——资产库在画布页本身可达（composer ＋ 菜单
    // 的「资产库」瓦片，移动端同一张卡，无 isMobileLayout 分支）。
    const pane = stripComments(read('../components/mobile/DiscoverPane.vue'))
    expect(pane, '资料库行已撤（社区流才是发现页主叙事）').not.toContain('资料库')
    expect(pane, '不再有跨页签跳转 emit').not.toContain('goto-canvas')
    // 有效性配对：资产库入口确实还在画布页（防「撤入口」变成「没人能打开资产库」）
    const rail = read('../components/agent/AgentSideRail.vue')
    expect(rail, 'composer 附件卡「资产库」瓦片必须在位').toContain('资产库')
    expect(rail, '瓦片点击仍直开资产库选择器').toContain('@click="pickAssetLibrary"')
    // 死代码链一并退役：壳层不再有 onDiscoverGotoCanvas / nextTick 编排
    expect(stripComments(shell), '壳层不得残留 onDiscoverGotoCanvas').not.toContain(
      'onDiscoverGotoCanvas',
    )
    expect(shell, 'DiscoverPane 不再接 @goto-canvas').not.toContain('@goto-canvas')
    // 契约里的 openAssetLibrary 条目同步撤除（否则接口声明了一个无人调用的动作）
    expect(stripComments(shell), 'MobileShellAgentActions 不得残留 openAssetLibrary').not.toContain(
      'openAssetLibrary',
    )
    expect(stripComments(page), 'CanvasPage 侧 agentActions 不得残留 openAssetLibrary').not.toContain(
      'openAssetLibrary',
    )
  })

  it('IA v4（第 5 点）：打开历史项目落【对话】页而非【画布】页', () => {
    // 用户原话：「回访用户进入对话页后，点击历史项目图标，默认进【对话】页而不是
    // 【画布】页，对话是创造的启动。」
    // ⇒ 跨项目定位（作品带点历史作品 → ?focusNode=）后不得再把页签切成 canvas：
    // 停在对话页签 + 窗态（画布可见 + composer 同屏），既看得见定位到的产物、
    // 又留着输入入口。
    const page = stripComments(read('./CanvasPage.vue'))
    const focusSingle = page.slice(page.indexOf('async function focusNodeById'))
    const focusBatch = page.slice(page.indexOf('async function focusNodesByIds'))
    for (const [name, body] of [
      ['focusNodeById', focusSingle],
      ['focusNodesByIds', focusBatch],
    ] as const) {
      expect(
        body.slice(0, body.indexOf('\n}')),
        `${name}：定位后不得切画布页签（对话是创造的启动）`,
      ).not.toContain("mobileAppTab.value = 'canvas'")
    }
    // 正向：从对话页定位 ⇒ 窗态（画布可见 + composer 同屏）；已在画布视图内定位 ⇒ 不改入口语义
    const immRule = 'mobileCanvasImm.value = enteringFromConversation ? true : mobileCanvasImm.value'
    expect(focusSingle.slice(0, focusSingle.indexOf('\n}'))).toContain(immRule)
    expect(focusBatch.slice(0, focusBatch.indexOf('\n}'))).toContain(immRule)
  })

  it('空态引导：画布页签 + 空 nodes 才显示', () => {
    expect(page).toMatch(/v-if="isMobileLayout && mobileAppTab === 'canvas' && !nodes\.length"/)
    expect(page).toContain('data-testid="mobile-canvas-empty"')
    // 2026-10-21 真机走查：「按住说话」能力在国内 Android 多数不可用 ⇒ 引导文案
    // 改为「点底部条输入」（诚实降级，不再承诺做不到的事）
    expect(page).toContain('点底部条输入')
    expect(page).not.toContain('按住底部条说话')
  })
})
