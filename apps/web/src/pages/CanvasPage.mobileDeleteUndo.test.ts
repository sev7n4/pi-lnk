import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, 'CanvasPage.vue'), 'utf-8')
// ⭐ 2026-10-27 S2（V-7）：toast 抽为 `MobileUndoToast` 组件——样式/标记迁到组件源，
// 页面源守**接线**（组件引用 + action 绑定 + undo 调用），组件源守**呈现判据**。
const TOAST_SRC = readFileSync(join(__dirname, '../components/mobile/MobileUndoToast.vue'), 'utf-8')

/**
 * D5（2026-10-25 规格 §4.11.10）：删除走**撤销优先**。
 *
 * iOS HIG：*"Undo beats 'Are you sure?' for reversible actions"* —— 节点删除
 * **可撤销**（仓库已有 `useCanvasUndoStack`，且明确处理 delete→undo 的 url/status
 * 恢复）⇒ 首选「删除 + Snackbar『撤销』」，二次确认弹层只作**不可撤销删除**的兜底。
 *
 * ⛔ 禁止「无撤销能力的删除 + 确认弹层」= 用模态换安全感，违反 iOS 的 Deference。
 */
describe('删除走撤销优先（D5 / §4.11.10）', () => {
  it('移动端删除动作必须产出可撤销提示（撤销优先），不得静默删除', () => {
    // ⚠️ 必须**精确定位 `case 'delete'`** —— 原 brief 写法 `indexOf('case ', 10)`
    //    取到的是 switch 的**第一个** case（'rename'），不是 delete 分支
    //    ⇒ 断言恒不命中（RED/GREEN 都红）。此处改为按 delete 关键字定位。
    const start = SRC.indexOf("case 'delete'")
    expect(start).toBeGreaterThan(-1)
    const deleteCase = SRC.slice(start, start + 400)
    // 要么走撤销（undo / 可撤销提示），要么走确认（confirm）—— 二者必居其一，不得裸删
    expect(deleteCase).toMatch(/undo|confirm|撤销/i)
  })

  it('删除后必须有可撤销提示的落地接线（canvasUndo.undo 被调用）', () => {
    expect(SRC).toMatch(/canvasUndo\.undo\(/)
  })

  it('可撤销提示：页面接线 MobileUndoToast（@action=undoLastDelete），组件层含「撤销」单一 action', () => {
    // 页面：组件被引用且 action 绑到 undoLastDelete（接线契约）
    expect(SRC).toMatch(/<MobileUndoToast/)
    expect(SRC).toMatch(/@action="undoLastDelete"/)
    // 组件：标记 + 单一「撤销」action（MD3 R5.16）
    expect(TOAST_SRC).toMatch(/mobile-undo-toast/)
    expect(TOAST_SRC).toMatch(/撤销/)
  })

  it('⛔ 撤销提示不得用 --neo-* 旧令牌（G-15：只消费 --lnk-*）', () => {
    const m = /\.mobile-undo-toast\s*\{[\s\S]*?\n\}/.exec(TOAST_SRC)
    expect(m).not.toBeNull()
    expect(m![0]).not.toContain('--neo-')
  })

  it('撤销提示时长 ≥5s（误删有恢复窗口）', () => {
    expect(SRC).toMatch(/UNDO_TOAST_DURATION_MS\s*=\s*5000|UNDO_TOAST_DURATION_MS\s*=\s*[6-9]\d{3}|UNDO_TOAST_DURATION_MS\s*=\s*\d{4,}/)
  })
})
