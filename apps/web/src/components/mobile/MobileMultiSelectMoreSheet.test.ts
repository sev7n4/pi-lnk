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