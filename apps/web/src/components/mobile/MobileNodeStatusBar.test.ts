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
 * 桌面已有 `SelectionBatchProgressCard` 做批量聚合；本组件是**单会话节点级**的
 * 移动端对应物（画布上散落各节点的生成中 / 待确认，收敛成一条）。
 *
 * ⭐ 不显示假百分比——只显示「N 个生成中」+ 已耗时。
 */
describe('MobileNodeStatusBar（壳层聚合状态栏）', () => {
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

  it('有待确认 → 显示「待确认」+ 确认 / 拒绝两个按钮', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [{ id: 'n1', title: '我的图' }] },
    })
    expect(w.text()).toContain('待确认')
    expect(w.find('.mobile-node-status-confirm').exists()).toBe(true)
    expect(w.find('.mobile-node-status-cancel').exists()).toBe(true)
    w.unmount()
  })

  it('点确认 → emit confirm(nodeId)', async () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [{ id: 'n1' }] },
    })
    await w.find('.mobile-node-status-confirm').trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual(['n1'])
    w.unmount()
  })

  it('点拒绝 → emit cancel(nodeId)', async () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [{ id: 'n2' }] },
    })
    await w.find('.mobile-node-status-cancel').trigger('click')
    expect(w.emitted('cancel')?.[0]).toEqual(['n2'])
    w.unmount()
  })

  it('多个待确认 → 显示数量且只渲染一组按钮（取第一个）', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [{ id: 'n1' }, { id: 'n2' }] },
    })
    expect(w.text()).toContain('2')
    expect(w.findAll('.mobile-node-status-confirm')).toHaveLength(1)
    w.unmount()
  })

  // ⭐ B1（2026-10-31 生产实证 cmvvaw8ar000moe01fdolrugb）：确认/拒绝必须**点名**目标节点。
  // 等待期 proposal 节点被 unshift 到队首，条上只写「待确认 · 2」⇒ 用户按画布上可见的
  // 另一个 pending 节点（小青蛙）的心智点「确认」，实际打到队首的小蝌蚪（等待开始
  // 8 秒后即被 answered，用户不知情）。点名后「点谁」在按下前可见。
  it('B1 回归：待确认文案点名目标节点标题（按下前可见「确认的是谁」）', () => {
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
    // 点名队首（实际确认目标），不是用户可能心智归属的另一个节点
    expect(target.text()).toContain('小蝌蚪')
    expect(target.text()).not.toContain('小青蛙')
    // 多项时保留数量提示
    expect(target.text()).toContain('2')
    w.unmount()
  })

  it('B1 回归：确认/拒绝 aria-label 带节点标题（读屏可辨目标）', () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 0, pendingNodes: [{ id: 'tadpole', title: '小蝌蚪' }] },
    })
    expect(w.find('.mobile-node-status-confirm').attributes('aria-label')).toContain('小蝌蚪')
    expect(w.find('.mobile-node-status-cancel').attributes('aria-label')).toContain('小蝌蚪')
    w.unmount()
  })

  it('B1 回归：多项时确认仍 emit 队首节点 id（点名与行为一致）', async () => {
    const w = mount(MobileNodeStatusBar, {
      props: {
        generatingCount: 0,
        pendingNodes: [
          { id: 'tadpole', title: '小蝌蚪' },
          { id: 'frog', title: '小青蛙' },
        ],
      },
    })
    await w.find('.mobile-node-status-confirm').trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual(['tadpole'])
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

  it('触控目标 ≥ 44px（两个按钮）', () => {
    const block = /<style scoped>([\s\S]*?)<\/style>/.exec(SRC)?.[1] ?? ''
    const rule = /\.mobile-node-status-btn[^{]*\{([^}]*)\}/.exec(block)?.[1] ?? ''
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

  it('点「N 个生成中」区 → emit open-tasks（§16-① 顶栏退役后的任务入口承接）', async () => {
    const w = mount(MobileNodeStatusBar, {
      props: { generatingCount: 2, pendingNodes: [] },
    })
    await w.find('[data-testid="mobile-node-status-open-tasks"]').trigger('click')
    expect(w.emitted('open-tasks')).toHaveLength(1)
    w.unmount()
  })
})
