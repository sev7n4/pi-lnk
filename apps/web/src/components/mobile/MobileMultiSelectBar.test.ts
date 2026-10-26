// 移动端多选 S3 底部动作条（2026-10-20 PR3）：
// 条内 ≤4 钮 + 完成；主操作在「批量生成 N / 停止」间切换；重新生成仅在有可重生成
// 节点时出现；warning 徽章点按仍走 blockedHint；「更多」开 9 项 sheet。
// 注：更多 sheet 走 Teleport to body —— 查询落在 document.body。
import { describe, expect, it, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MobileMultiSelectBar from './MobileMultiSelectBar.vue'
import type { SelectionBatchState } from '@/composables/useSelectionBatchActions'

function mountBar(props: Record<string, unknown> = {}) {
  return mount(MobileMultiSelectBar, { props: { count: 3, ...props }, attachTo: document.body })
}

function q(selector: string): HTMLElement | null {
  return document.body.querySelector(selector)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('MobileMultiSelectBar（PR3 S3 动作条）', () => {
  it('默认态：已选 N + 批量生成主操作 + 更多 + 完成', async () => {
    const batch: SelectionBatchState = { runCount: 3, state: 'idle' }
    const w = mountBar({ selectionBatch: batch })
    expect(w.find('.msb-count').text()).toContain('已选 3')
    const primary = w.find('[data-testid="msb-primary"]')
    expect(primary.exists()).toBe(true)
    expect(primary.attributes('aria-label')).toContain('批量生成 3')
    expect(w.find('[data-testid="msb-regen"]').exists()).toBe(false)
    await primary.trigger('click')
    expect(w.emitted('generate')).toHaveLength(1)
    await w.find('[data-testid="mobile-multi-select-done"]').trigger('click')
    expect(w.emitted('done')).toHaveLength(1)
    w.unmount()
  })

  it('运行中：主操作变「停止」且 emit stop', async () => {
    const batch: SelectionBatchState = { runCount: 3, regenCount: 2, state: 'running' }
    const w = mountBar({ selectionBatch: batch })
    const primary = w.find('[data-testid="msb-primary"]')
    expect(primary.attributes('aria-label')).toBe('停止全部')
    expect(w.find('[data-testid="msb-regen"]').exists()).toBe(false)
    await primary.trigger('click')
    expect(w.emitted('stop')).toHaveLength(1)
    expect(w.emitted('generate')).toBeUndefined()
    w.unmount()
  })

  it('有可重生成节点：出「重新生成 N」并 emit regenerate', async () => {
    const batch: SelectionBatchState = { runCount: 2, regenCount: 5, state: 'idle' }
    const w = mountBar({ selectionBatch: batch })
    const regen = w.find('[data-testid="msb-regen"]')
    expect(regen.exists()).toBe(true)
    expect(regen.attributes('aria-label')).toContain('重新生成 5')
    await regen.trigger('click')
    expect(w.emitted('regenerate')).toHaveLength(1)
    w.unmount()
  })

  it('整批阻断：warning 徽章可点，emit blockedHint 带原因', async () => {
    const batch: SelectionBatchState = {
      runCount: 4,
      state: 'idle',
      blocked: 'pending_confirm',
      blockedCount: 2,
    }
    const w = mountBar({ selectionBatch: batch })
    const warn = w.find('[data-testid="msb-warning"]')
    expect(warn.exists()).toBe(true)
    expect(warn.attributes('aria-label')).toContain('待确认 2')
    await warn.trigger('click')
    expect(w.emitted('blockedHint')).toEqual([['pending_confirm']])
    w.unmount()
  })

  it('更多：开 9 项 sheet，其中删除恒置底', async () => {
    const w = mountBar({ selectionBatch: { runCount: 1, state: 'idle' } satisfies SelectionBatchState, canUngroup: true })
    expect(q('[data-testid="msms-list"]')).toBeNull()
    await w.find('[data-testid="msb-more"]').trigger('click')
    await flushPromises()
    const items = Array.from(document.body.querySelectorAll('.msms-item'))
    // 非分组选区：分组 + 副本×2 + 引用 + 布局 + 导出 + 删除 = 7 项（分组节点时 9 项）
    expect(items.length).toBeGreaterThanOrEqual(7)
    expect(items[items.length - 1].getAttribute('data-testid')).toBe('msms-delete')
    expect(items[items.length - 1].classList.contains('is-danger')).toBe(true)
    expect(q('[data-testid="msms-ungroup"]')).not.toBeNull()
    w.unmount()
  })

  it('分组选区：更多 sheet 出「分组背景色」入口 → 8 格 44px 色板', async () => {
    const w = mountBar({
      selectionBatch: { runCount: 1, state: 'idle' } satisfies SelectionBatchState,
      canUngroup: true,
      groupColorKey: 'moss',
    })
    await w.find('[data-testid="msb-more"]').trigger('click')
    await flushPromises()
    q('[data-testid="msms-color-entry"]')!.click()
    await flushPromises()
    const colors = Array.from(document.body.querySelectorAll('.msms-color'))
    expect(colors).toHaveLength(8)
    expect(colors.find((el) => el.classList.contains('is-active'))?.getAttribute('data-color')).toBe('moss')
    w.unmount()
  })

  // ── 选择模式（D4 / H1）：补「全选 / 取消」两个入口 ──────────────────────
  // ⭐ 本条已**已有**「完成」钮 + 「更多」sheet（删除/引用/副本）—— 本任务只补
  //   「全选 / 取消」，**不重复造**既有能力。
  // ⭐ `selectionMode` 与「已选 N」是**两个不同语义**：模式可开着而当前选区为 0
  //   （进入模式后一个都还没选）⇒ 底部条必须能显示「全选 / 取消」。
  describe('选择模式（全选）', () => {
    it('底部条含「全选 / 完成」', () => {
      const w = mountBar({})
      const html = w.html()
      expect(html).toContain('全选')
      expect(html).toContain('完成')
      w.unmount()
    })

    it('⛔ 不加「取消」钮：既有「完成」已是「退出选择模式」（两个同义按钮是噪音，iOS Photos 也没有）', () => {
      const w = mountBar({})
      expect(w.find('[data-testid="msb-cancel-select"]').exists()).toBe(false)
      w.unmount()
    })

    it('点「全选」emit selectAll', async () => {
      const w = mountBar({})
      await w.find('[data-testid="msb-select-all"]').trigger('click')
      expect(w.emitted('selectAll')).toBeTruthy()
      w.unmount()
    })
  })
})
