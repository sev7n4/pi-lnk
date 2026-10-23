// 多选「更多」sheet 的二级视图与动作契约（2026-10-20 PR3）：
// PC 把布局/导出/分组色塞进 hover 下拉——触屏不可达，故搬进二级视图；
// 分组色 8 格 44px；删除恒置底 + danger。sheet 走 Teleport to body。
import { describe, expect, it, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MobileMultiSelectMoreSheet from './MobileMultiSelectMoreSheet.vue'

function mountSheet(props: Record<string, unknown> = {}) {
  return mount(MobileMultiSelectMoreSheet, { props, attachTo: document.body })
}

function q(selector: string): HTMLElement | null {
  return document.body.querySelector(selector)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('MobileMultiSelectMoreSheet（PR3）', () => {
  it('非分组选区：隐藏解组与分组色，其余 7 项在列', async () => {
    const w = mountSheet()
    expect(q('[data-testid="msms-ungroup"]')).toBeNull()
    expect(q('[data-testid="msms-color-entry"]')).toBeNull()
    expect(Array.from(document.body.querySelectorAll('.msms-item'))).toHaveLength(7)
    w.unmount()
  })

  it('分组选区：9 项齐（PC 工具条同款能力集）', async () => {
    const w = mountSheet({ canUngroup: true })
    expect(Array.from(document.body.querySelectorAll('.msms-item'))).toHaveLength(9)
    w.unmount()
  })

  it('动作透传：分组/副本/引用/删除各自 emit', async () => {
    const w = mountSheet({ canUngroup: true })
    q('[data-testid="msms-group"]')!.click()
    q('[data-testid="msms-duplicate"]')!.click()
    q('[data-testid="msms-duplicate-upstream"]')!.click()
    q('[data-testid="msms-add-ref"]')!.click()
    q('[data-testid="msms-ungroup"]')!.click()
    q('[data-testid="msms-delete"]')!.click()
    await flushPromises()
    expect(w.emitted('group')).toHaveLength(1)
    expect(w.emitted('duplicate')).toHaveLength(1)
    expect(w.emitted('duplicateUpstream')).toHaveLength(1)
    expect(w.emitted('addAgentRef')).toHaveLength(1)
    expect(w.emitted('ungroup')).toHaveLength(1)
    expect(w.emitted('delete')).toHaveLength(1)
    w.unmount()
  })

  it('整理布局二级视图：2 项 + 返回回主列表', async () => {
    const w = mountSheet()
    q('[data-testid="msms-layout"]')!.click()
    await flushPromises()
    expect(q('[data-testid="msms-list"]')).toBeNull()
    q('[data-testid="msms-layout-along"]')!.click()
    await flushPromises()
    expect(w.emitted('layout')).toEqual([['along_edges']])
    q('[data-testid="msms-back"]')!.click()
    await flushPromises()
    expect(q('[data-testid="msms-list"]')).not.toBeNull()
    w.unmount()
  })

  it('SP-B 对齐二级视图：六向对齐 + 两轴等距，emit align（判别联合负载）', async () => {
    const w = mountSheet()
    q('[data-testid="msms-layout"]')!.click()
    await flushPromises()

    for (const id of [
      'msms-align-left',
      'msms-align-centerH',
      'msms-align-right',
      'msms-align-top',
      'msms-align-centerV',
      'msms-align-bottom',
      'msms-distribute-x',
      'msms-distribute-y',
    ]) {
      expect(q(`[data-testid="${id}"]`), `整理布局视图应有 ${id}`).not.toBeNull()
    }

    q('[data-testid="msms-align-left"]')!.click()
    await flushPromises()
    expect(w.emitted('align')).toEqual([[{ kind: 'align', alignMode: 'left' }]])

    // 回主列表再进，等距走另一个分支
    q('[data-testid="msms-back"]')!.click()
    await flushPromises()
    q('[data-testid="msms-layout"]')!.click()
    await flushPromises()
    q('[data-testid="msms-distribute-y"]')!.click()
    await flushPromises()
    expect(w.emitted('align')).toEqual([
      [{ kind: 'align', alignMode: 'left' }],
      [{ kind: 'distribute', axis: 'y' }],
    ])
    w.unmount()
  })

  it('导出二级视图：3 种口径', async () => {
    const w = mountSheet()
    q('[data-testid="msms-export"]')!.click()
    await flushPromises()
    q('[data-testid="msms-export-media"]')!.click()
    await flushPromises()
    expect(w.emitted('download')).toEqual([['media_list_only']])
    w.unmount()
  })

  it('分组色：选中即 emit groupColor（默认色 neutral 兜底）', async () => {
    const w = mountSheet({ canUngroup: true })
    q('[data-testid="msms-color-entry"]')!.click()
    await flushPromises()
    const rose = document.body.querySelector('[data-color="rose"]') as HTMLElement
    rose.click()
    await flushPromises()
    expect(w.emitted('groupColor')).toEqual([['rose']])
    w.unmount()
  })
})

// 2026-10-23 IA 重排：10 个平级动作 → 两张分组卡片（重排 / 规整）+ 紧凑网格。
// 起因：10 行竖排（10 × 44px）在移动端 sheet 里被底部裁掉。
describe('MobileMultiSelectMoreSheet：整理布局分组卡片（IA 重排）', () => {
  it('整理布局视图分「重排 / 规整」两张卡片，六向进紧凑网格（不再 10 行竖排）', async () => {
    const w = mountSheet()
    q('[data-testid="msms-layout"]')!.click()
    await flushPromises()

    expect(q('[data-testid="msms-card-rearrange"]'), '应有「重排」卡片').not.toBeNull()
    expect(q('[data-testid="msms-card-tidy"]'), '应有「规整」卡片').not.toBeNull()
    expect(q('[data-testid="msms-align-grid"]'), '六向应在紧凑网格里').not.toBeNull()

    // 分组标题文案（用户靠它理解「重排 vs 规整」的差别）
    expect(q('[data-testid="msms-card-rearrange"]')!.textContent).toContain('重排')
    expect(q('[data-testid="msms-card-tidy"]')!.textContent).toContain('规整')

    // ⛔ 六向不得再散在「重排」卡片里（分组错位 = 语义误导）
    const rearrange = q('[data-testid="msms-card-rearrange"]')!
    expect(rearrange.querySelectorAll('[data-testid^="msms-align-"]').length).toBe(0)

    // 竖排 10 项已消失：layout 视图内 .msms-item 计数为 0（改卡片/网格）
    const layoutView = q('[data-testid="msms-layout-groups"]')!
    expect(layoutView.querySelectorAll('.msms-item').length).toBe(0)

    w.unmount()
  })

  it('「重排」两项与「规整」八项仍全部可点且 emit 正确负载（分组不改行为）', async () => {
    const w = mountSheet()
    q('[data-testid="msms-layout"]')!.click()
    await flushPromises()

    q('[data-testid="msms-layout-grid"]')!.click()
    await flushPromises()
    expect(w.emitted('layout')).toEqual([['grid']])

    q('[data-testid="msms-back"]')!.click()
    await flushPromises()
    q('[data-testid="msms-layout"]')!.click()
    await flushPromises()
    q('[data-testid="msms-align-bottom"]')!.click()
    await flushPromises()
    expect(w.emitted('align')).toEqual([[{ kind: 'align', alignMode: 'bottom' }]])

    w.unmount()
  })
})