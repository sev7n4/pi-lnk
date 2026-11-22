import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileNodeStatusBar from './MobileNodeStatusBar.vue'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'MobileNodeStatusBar.vue'), 'utf8')

/**
 * 移动端壳层聚合状态栏（R3-T4）。
 *
 * D-C 状态机：「把『生成中/待确认』从逐卡堆砌收敛到瓦片轻态 + 壳层状态栏聚合」。
 * ⭐ 2026-11-22 决策面收归对话页：本组件只留**状态面**（查看），确认/拒绝两钮退场，
 *   新增「去对话处理」跳转（不代发答案、不改节点状态）——决策唯一入口在对话时间线卡。
 *
 * ⭐ 不显示假百分比——只显示「N 个生成中」+ 已耗时。
 */
describe('MobileNodeStatusBar（壳层聚合状态栏 — 状态面）', () => {
  it('无任务时不渲染（不占位、不噪音）', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [] },
    })
    expect(w.find('.mobile-node-status-bar').exists()).toBe(false)
    w.unmount()
  })

  it('有生成中 → 显示「N 个生成中」', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 3, pendingNodes: [] },
    })
    expect(w.find('.mobile-node-status-bar').exists()).toBe(true)
    expect(w.text()).toContain('3')
    expect(w.text()).toContain('生成中')
    w.unmount()
  })

  it('有生成中 → 显示计时（已耗时），不显示任何百分比', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 1, pendingNodes: [], elapsedText: '1:23' },
    })
    expect(w.text()).toContain('1:23')
    expect(w.text()).not.toMatch(/\d+%/)
    w.unmount()
  })

  it('待确认态显示「待确认」文案，但不再有确认/拒绝决策按钮', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [{ id: 'n1', title: '我的图' }] },
    })
    expect(w.text()).toContain('待确认')
    expect(w.find('.mobile-node-status-confirm').exists()).toBe(false)
    expect(w.find('.mobile-node-status-cancel').exists()).toBe(false)
    w.unmount()
  })

  it('待确认态显示「去对话处理」，点击 emit go-chat（只切 Tab，不发答案）', async () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [{ id: 'n1', title: '我的图' }] },
    })
    const btn = w.find('[data-testid="mobile-node-status-go-chat"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('去对话处理')
    await btn.trigger('click')
    expect(w.emitted('go-chat')).toHaveLength(1)
    expect(w.emitted('confirm')).toBeUndefined()
    expect(w.emitted('cancel')).toBeUndefined()
    w.unmount()
  })

  it('无待确认时不渲染「去对话处理」（只在有待办时给跳转）', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 2, pendingNodes: [] },
    })
    expect(w.find('[data-testid="mobile-node-status-go-chat"]').exists()).toBe(false)
    w.unmount()
  })

  it('多个待确认 → 文案显示数量，跳转仍只有一个', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [{ id: 'n1' }, { id: 'n2' }] },
    })
    expect(w.text()).toContain('2')
    expect(w.findAll('[data-testid="mobile-node-status-go-chat"]')).toHaveLength(1)
    w.unmount()
  })

  // ⭐ B1（2026-10-31 生产实证）保留点名纪律：虽然不再有确认按钮，
  //   状态文案仍须点名目标节点——用户去对话页后知道要找哪张卡。
  it('B1 回归：待确认文案点名目标节点标题（按待确认时刻可见）', () => {
    const w = mount(MobileNodeStatusBar, {
      props: {
        generatingCount: 0,
        pendingNodes: [
          { id: 'tadpole', title: '小蝌蚪' },
          { id: 'frog', title: '小青蛙' },
        ],
      },
    })
    const target = w.find('[data-testid="mobile-node-status-pending-target"]')
    expect(target.exists()).toBe(true)
    expect(target.text()).toContain('小蝌蚪')
    expect(target.text()).not.toContain('小青蛙')
    expect(target.text()).toContain('2')
    w.unmount()
  })

  it('B1 回归：无标题节点降级为「待确认」（不显示空名字）', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [{ id: 'n1' }] },
    })
    const target = w.find('[data-testid="mobile-node-status-pending-target"]')
    expect(target.text()).toContain('待确认')
    expect(target.text()).not.toContain('·')
    w.unmount()
  })

  it('触控目标 ≥ 44px（去对话处理钮）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    const rule = /\.mobile-node-status-go-chat[^{]*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(rule).toMatch(/min-width:\s*var\(--lnk-touch-target\)/)
    expect(rule).toMatch(/min-height:\s*var\(--lnk-touch-target\)/)
  })

  it('样式纪律：只用 --lnk-* 令牌（无裸 hex / rgba）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(block).not.toMatch(/rgba?\(/)
  })

  it('固定贴底（fixed + bottom），与壳层底部带同坐标系', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    const rule = /\.mobile-node-status-bar[^{]*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(rule).toMatch(/position:\s*fixed/)
    expect(rule).toMatch(/bottom:/)
  })

  it('点「N 个生成中」区 → emit open-tasks（任务入口承接）', async () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 2, pendingNodes: [] },
    })
    await w.find('[data-testid="mobile-node-status-open-tasks"]').trigger('click')
    expect(w.emitted('open-tasks')).toHaveLength(1)
    w.unmount()
  })
})
