// 批量派生单一出处（2026-10-20 PR3）：PC MultiSelectToolbar 与移动端 S3 动作条
// 共用 `useSelectionBatchActions`。这里锁死口径——尤其「纯缺提示词选区不得静默」
// 与「运行中主按钮恒为停止」两条语义（PC 历史行为，移动端沿用，回归即红）。
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import {
  useSelectionBatchActions,
  type SelectionBatchState,
} from './useSelectionBatchActions'

function setup(initial?: SelectionBatchState) {
  const batch = ref<SelectionBatchState | undefined>(initial)
  const api = useSelectionBatchActions(() => batch.value)
  return { batch, api }
}

describe('useSelectionBatchActions（PR3 批量派生口径）', () => {
  it('无可执行节点也无重生成对象：保留「生成」入口（PC 历史行为，不静默无按钮）', () => {
    const { api } = setup({ runCount: 0, state: 'idle' })
    expect(api.showGenerateButton.value).toBe(true)
    expect(api.showRegenButton.value).toBe(false)
    expect(api.primary.value).toBe('generate')
  })

  it('纯缺提示词选区：无生成/重生成入口 + warning=missing_prompt（不静默「生成 · 0」）', () => {
    const { api } = setup({ runCount: 0, regenCount: 0, state: 'idle', missingCount: 3 })
    expect(api.showMissingButton.value).toBe(true)
    expect(api.showGenerateButton.value).toBe(false)
    expect(api.showRegenButton.value).toBe(false)
    expect(api.primary.value).toBe(null)
    expect(api.warning.value).toEqual({ reason: 'missing_prompt', count: 3 })
  })

  it('整批阻断：warning 徽章优先于缺词；阻断不禁用生成入口（PC 语义：警示与入口并存）', () => {
    const { api } = setup({
      runCount: 5,
      state: 'idle',
      blocked: 'pending_confirm',
      blockedCount: 2,
      missingCount: 1,
    })
    expect(api.warning.value).toEqual({ reason: 'pending_confirm', count: 2 })
    // PC 历史行为：阻断只加警示钮，生成入口仍在（点了由 host 弹提示）——
    // 抽 composable 时逐字保留，不在此处"顺手修正"，否则两端口径分叉。
    expect(api.showGenerateButton.value).toBe(true)
    expect(api.showRegenButton.value).toBe(false)
    expect(api.blockedTitle.value).toContain('待确认')
  })

  it('有已完成节点时出「重新生成」入口', () => {
    const { api } = setup({ runCount: 2, regenCount: 4, state: 'idle' })
    expect(api.showGenerateButton.value).toBe(true)
    expect(api.showRegenButton.value).toBe(true)
    expect(api.regenCount.value).toBe(4)
  })

  it('运行中（含 stopping）：主按钮恒为停止；重生成入口仍存在（PC 语义，点它也=停止）', () => {
    for (const state of ['running', 'stopping'] as const) {
      const { api } = setup({ runCount: 3, regenCount: 1, state })
      expect(api.running.value).toBe(true)
      expect(api.primary.value).toBe('stop')
      // PC 两个钮在运行中都渲染、都 emit stop；移动端动作条在**组件层**只留一个
      // 停止钮（两个一模一样会误触），语义差异不落在这里。
      expect(api.showRegenButton.value).toBe(true)
    }
  })

  it('未接入批量能力（undefined）：退化为「生成」入口且无徽章', () => {
    const { api } = setup(undefined)
    expect(api.showGenerateButton.value).toBe(true)
    expect(api.warning.value).toBe(null)
    expect(api.primary.value).toBe('generate')
  })
})