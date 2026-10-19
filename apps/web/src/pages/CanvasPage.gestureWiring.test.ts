// P0-1 手势断点分流契约（2026-10-19 移动端画布重构 D-3）：
// ① CanvasPage 的 VueFlow 手势 props 必须走 useViewportGestures 单一出处，
//    不再内联 [1,2] / true（内联写法正是触屏 touchstart 被 d3 filter 拒掉的根因）；
// ② 移动端分支必须关框选（selectionKeyCode=null）+ 开平移（panOnDrag=true）；
// ③ 多选态必须摘除 vue-flow 内部选中（nodes-selectable=false），选择归应用层。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')

describe('mobile viewport gesture wiring (P0-1)', () => {
  const page = read('./CanvasPage.vue')

  it('VueFlow 手势 props 消费 viewportGestures，无内联数组/布尔', () => {
    expect(page, '必须引入 useViewportGestures').toContain(
      "import { useViewportGestures } from '@/composables/useViewportGestures'",
    )
    expect(page, '必须实例化 viewportGestures').toContain('useViewportGestures(')
    // 四个手势 prop 全部走 computed 单一出处
    expect(page).toMatch(/:selection-key-code="viewportGestures\.selectionKeyCode"/)
    expect(page).toMatch(/:pan-on-drag="viewportGestures\.panOnDrag"/)
    expect(page).toMatch(/:pan-on-scroll="viewportGestures\.panOnScroll"/)
    expect(page).toMatch(/:zoom-on-pinch="viewportGestures\.zoomOnPinch"/)
    // 内联写法清零（曾致触屏 d3 filter 拒绝全部 touchstart）
    expect(page, 'pan-on-drag 不得再内联 [1,2]').not.toMatch(/:pan-on-drag="[^"]*\[1, 2\]/)
    expect(page, 'selection-key-code 不得再内联 true').not.toMatch(/:selection-key-code="[^"]*true"/)
  })

  it('移动端多选态摘除 vue-flow 内部选中（nodes-selectable 联动）', () => {
    expect(page).toMatch(/:nodes-selectable="[^"]*mobileMultiSelectActive"/)
  })

  it('多选模式状态与长按链路注入齐套', () => {
    expect(page).toContain('CANVAS_NODE_OPEN_CONTEXT_MENU_KEY')
    expect(page).toContain('CANVAS_NODE_CLICK_GUARD_KEY')
    expect(page).toContain('CANVAS_MULTI_SELECT_ACTIVE_KEY')
    expect(page).toContain('CANVAS_NODE_RENAME_REQUEST_KEY')
    expect(page).toContain('function enterMultiSelectMode')
    expect(page).toContain('function toggleNodeInMultiSelect')
  })

  it('上下文菜单 action 覆盖 rename / multi-select（P0-4 / D-4）', () => {
    const handler = page.match(/function handleContextAction[\s\S]*?\n}/)?.[0] ?? ''
    expect(handler).toContain("action === 'rename'")
    expect(handler).toContain("action === 'multi-select'")
  })
})
