import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 移动端「页签失灵」回归守卫（2026-10-19 真机反馈）：
 * 全屏遮罩 z-index（95/96）> 页签（80），遮罩若 `inset: 0` 盖住页签区，
 * 点页签只会触发遮罩 @click.self 自关、不切页签（第一次点没反应、第二次才生效）。
 * 修复方式：遮罩 bottom 让开页签 —— `bottom: var(--lnk-tabbar-h, 56px)`。
 *
 * 2026-10-20 起范围扩展为「贴底容器跨页签泄漏」家族守卫：
 * 画布/发现/我的页签下，对话 chrome（系统层卡片）不得残留在透明壳里浮在页面上。
 *
 * 断言只作用于提取出的 CSS 规则块内部（不含注释），避免「记录被删历史」的
 * 注释文本污染否定断言；每个否定断言都配有块存在性 + 关键属性的有效性断言。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SFC_PATH = join(HERE, 'AgentSideRail.vue')

/** 提取 `selector { ... }` 规则块（本组件遮罩规则无嵌套，首个 `}` 即块尾） */
function extractRuleBlock(sfc: string, selector: string): string {
  const at = sfc.indexOf(selector)
  if (at < 0) return ''
  const open = sfc.indexOf('{', at)
  const close = sfc.indexOf('}', open)
  if (open < 0 || close < 0) return ''
  return sfc.slice(open + 1, close)
}

describe('mobile mask never covers the tab bar (页签失灵回归守卫)', () => {
  const sfc = readFileSync(SFC_PATH, 'utf8')

  it('thread-history-layer 遮罩 bottom 让开页签区', () => {
    const block = extractRuleBlock(sfc, '.thread-history-layer')
    // 有效性：块存在且是 fixed 定位（防止选择器改名导致断言空转）
    expect(block).toContain('position: fixed')
    // 让开页签：bottom 走 --lnk-tabbar-h，兜底 56px（变量未发布时也不得回落成盖住页签）
    expect(block).toContain('bottom: var(--lnk-tabbar-h, 56px)')
    // 不许再出现整屏 inset: 0
    expect(block).not.toMatch(/inset:\s*0/)
  })

  it('session-drawer-layer 遮罩同样让开页签区（兜底 56px 加固）', () => {
    const block = extractRuleBlock(sfc, '.session-drawer-layer')
    expect(block).toContain('position: fixed')
    expect(block).toContain('bottom: var(--lnk-tabbar-h, 56px)')
    expect(block).not.toMatch(/inset:\s*0/)
  })

  it('切页签时自动收起对话历史面板（mobileAppTab watch）', () => {
    // watch 内必须同时收抽屉与历史面板，否则面板开着切页签会挂在页面上
    expect(sfc).toContain('mobileThreadHistoryOpen.value) closeThreadHistory()')
    expect(sfc).toContain('sessionDrawerOpen.value) closeSessionDrawer()')
  })

  it('发现/我的页签：贴底容器（Teleport 到 body）自身隐藏，整页不得盖住页签页', () => {
    // 回归 2026-10-20：dialog 的 aside hidden 管不到 Teleport 内容，z 又高于 main.z-10，
    // 从对话/画布切到发现/我的会整页覆盖或裸露状态行。由容器自身 v-show 收口。
    expect(sfc).toContain('v-show="open && !railHiddenByTab"')
    expect(sfc).toContain('mobileAppTab === \'discover\' || props.mobileAppTab === \'mine\'')
  })

  it('画布视图：收口状态行与对话 chrome 一律不同屏', () => {
    // 回归 2026-10-20：隐藏清单曾漏 .agent-turn-status，导致画布（尤其 imm）状态行裸露。
    const block = extractRuleBlock(sfc, '.agent-panel-mobile-dock.is-canvas-view .agent-turn-status')
    expect(block).toContain('display: none')
  })

  it('画布视图：ask_user 卡与「取消」回执卡不得浮在画布上（真机复现回归）', () => {
    // 回归 2026-10-20 真机截图：P1-5 把 ask_user 卡移出 chat-wrap 进系统层后，
    // 画布视图隐藏清单漏了它——切到画布页签，消息流/输入条被 display:none 藏掉，
    // 卡片成为透明贴底壳里唯一可见子元素，孤悬在画布上（run-cancelled-callout 同病）。
    // 双向断言：先钉模板稳定钩子（钩子被改名/删掉时先红，避免 CSS 选择器空转），再钉隐藏规则。
    expect(sfc).toContain('class="mx-0.5 mb-2 agent-ask-layer"')
    expect(sfc).toContain('class="mb-2 px-0.5 agent-cancelled-layer"')
    const askBlock = extractRuleBlock(sfc, '.agent-panel-mobile-dock.is-canvas-view .agent-ask-layer')
    expect(askBlock).toContain('display: none')
    const cancelledBlock = extractRuleBlock(sfc, '.agent-panel-mobile-dock.is-canvas-view .agent-cancelled-layer')
    expect(cancelledBlock).toContain('display: none')
  })

  it('画布视图：propose 等待提示必须放行（有画布专属文案，不得被隐藏清单误伤）', () => {
    // propose-wait-hint 是系统层里唯一「画布视图也要可见」的卡片（proposeWaitInCanvas
    // 文案：「已在画布上待确认…」）。若有人图省事把整个系统层加进隐藏清单，这条会红。
    const rule = sfc.slice(sfc.indexOf('.agent-panel-mobile-dock.is-canvas-view .agent-panel-header'))
    expect(rule).not.toContain('.is-canvas-view .propose-wait-hint')
    expect(sfc).toContain('proposeWaitInCanvas')
  })
})
