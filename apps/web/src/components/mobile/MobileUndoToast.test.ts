// 删除撤销提示组件（D5 / §4.11.10）+ V-7 端到端等价链的行为断言：
// 组件层（渲染/点击/aria）× 撤销栈（快照恢复）× 页面接线（静态契约见
// CanvasPage.mobileDeleteUndo.test.ts）—— 三层合起来构成「点撤销 ⇒ 节点恢复」。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import MobileUndoToast from './MobileUndoToast.vue'
import { createCanvasUndoStack } from '@/composables/useCanvasUndoStack'
import type { CanvasSnapshot } from '@/composables/useCanvasUndoStack'

const COMPONENT_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'MobileUndoToast.vue'),
  'utf-8',
)

describe('MobileUndoToast 组件行为（V-7 · D5）', () => {
  it('渲染消息 + 单一「撤销」action（MD3 R5.16）', () => {
    const w = mount(MobileUndoToast, { props: { message: '已删除节点「封面图」' } })
    expect(w.find('[data-testid="mobile-undo-toast"]').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-undo-toast"]').text()).toContain('已删除节点「封面图」')
    // 单一 action：恰好一个按钮，文案「撤销」
    expect(w.findAll('button')).toHaveLength(1)
    expect(w.find('[data-testid="mobile-undo-toast-action"]').text()).toBe('撤销')
    w.unmount()
  })

  it('role=status + aria-live=polite（§15.10 可播报）', () => {
    const w = mount(MobileUndoToast, { props: { message: 'x' } })
    expect(w.find('[data-testid="mobile-undo-toast"]').attributes('role')).toBe('status')
    expect(w.find('[data-testid="mobile-undo-toast"]').attributes('aria-live')).toBe('polite')
    w.unmount()
  })

  it('点「撤销」⇒ emit action（行为级，替代原纯静态断言）', async () => {
    const w = mount(MobileUndoToast, { props: { message: 'x' } })
    await w.find('[data-testid="mobile-undo-toast-action"]').trigger('click')
    expect(w.emitted('action')).toHaveLength(1)
    w.unmount()
  })

  it('⛔ reduce-motion：入场动画在 prefers-reduced-motion 下禁用（静态源契约）', () => {
    expect(COMPONENT_SRC).toContain('@media (prefers-reduced-motion: reduce)')
    expect(COMPONENT_SRC).toContain('animation: none')
  })
})

describe('V-7 端到端等价链：action → undo ⇒ 节点恢复（行为级）', () => {
  // 复刻页面链路的最后一环：MobileUndoToast @action → undoLastDelete → canvasUndo.undo()
  // → 快照恢复（页面接线由 CanvasPage.mobileDeleteUndo.test.ts 静态契约守卫）。
  function makeSnapshot(nodeId: string): CanvasSnapshot {
    return {
      nodes: [{ id: nodeId, type: 'image', position: { x: 0, y: 0 }, data: { url: 'x.png', prompt: '词' } }],
      edges: [],
    }
  }

  it('点撤销 → canvasUndo.undo() ⇒ 被删节点回到快照', async () => {
    let nodes = makeSnapshot('n1')
    const undo = createCanvasUndoStack({
      getSnapshot: () => nodes,
      applySnapshot: (s) => {
        nodes = s
      },
    })
    // 现状入栈（commit 后 present = 含 n1 的快照）
    undo.commitAfterChange()
    // 模拟删除：节点消失 + commit（与页面删除动作同构）
    nodes = { nodes: [], edges: [] }
    undo.commitAfterChange()
    expect(nodes.nodes).toHaveLength(0)

    // 页面链路：toast action → undoLastDelete（dismiss + undo）
    const w = mount(MobileUndoToast, { props: { message: '已删除节点' } })
    await w.find('[data-testid="mobile-undo-toast-action"]').trigger('click')
    const restored = undo.undo()
    expect(restored).toBe(true)
    expect(nodes.nodes.map((n) => n.id)).toEqual(['n1'])
    expect(nodes.nodes[0]!.data).toMatchObject({ url: 'x.png' })
    w.unmount()
  })
})
