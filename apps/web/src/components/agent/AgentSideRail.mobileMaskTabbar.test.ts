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
})
