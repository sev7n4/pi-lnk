import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AutoApproveControl from './AutoApproveControl.vue'

/**
 * 授权自动生成 · composer 入口（规格 2026-11-22-generation-auto-approve-gate-design §11）。
 *
 * 契约（用户拍板：状态胶囊 + 锚定浮层）：
 * 1. PC = 状态胶囊（图标 +「自动生成」+ 箭头）：关闭态弱化、开启态琥珀高亮；
 *    点击**开浮层**（不是直接收回）——双向操作都在浮层里的开关上；
 * 2. 浮层承载**作用域说明**（图片与音频免确认 / 视频仍逐次确认）+ 一个 `role=switch` 开关；
 * 3. 移动 = icon-only 触发器（裸条三件套纪律）+ 底部 Sheet（同一份面板 ⇒ 同一组件）；
 * 4. 开关动作写回服务端（`setAuthorized`），组件自身不做本地判定、不缓存。
 */

const h = vi.hoisted(() => ({ authorized: false, calls: [] as boolean[] }))

vi.mock('@/composables/useAutoApproveGeneration', async () => {
  const { computed } = await import('vue')
  return {
    useAutoApproveGeneration: () => ({
      authorized: computed(() => h.authorized),
      setAuthorized: async (next: boolean) => {
        h.authorized = next
        h.calls.push(next)
        return true
      },
    }),
  }
})

const sheetStub = { template: '<div class="stub-sheet"><slot /></div>' }

function mountControl(props: Record<string, unknown> = {}) {
  return mount(AutoApproveControl, {
    props: { desktop: true, ...props },
    global: { stubs: { MobileSheet: sheetStub } },
  })
}

beforeEach(() => {
  h.authorized = false
  h.calls.length = 0
})

describe('AutoApproveControl — composer 入口', () => {
  it('PC 未授权：胶囊常驻（图标 +「自动生成」），图形线框，浮层默认关闭', () => {
    const w = mountControl()
    const chip = w.find('[data-testid="auto-approve-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('自动生成')
    expect(chip.classes()).not.toContain('is-on')
    expect(w.find('svg.auto-approve-glyph').classes()).not.toContain('is-on')
    expect(w.find('[data-testid="auto-approve-popover"]').exists()).toBe(false)
    w.unmount()
  })

  it('PC 点击胶囊 ⇒ 展开锚定浮层：说明写清作用域 + 一个 role=switch 开关', async () => {
    const w = mountControl()
    await w.find('[data-testid="auto-approve-chip"]').trigger('click')
    const pop = w.find('[data-testid="auto-approve-popover"]')
    expect(pop.exists()).toBe(true)
    const desc = pop.find('[data-testid="auto-approve-panel-desc"]').text()
    expect(desc).toContain('图片与音频')
    expect(desc).toContain('视频仍会逐次确认')
    const sw = pop.find('[data-testid="auto-approve-panel-switch"]')
    expect(sw.attributes('role')).toBe('switch')
    expect(sw.attributes('aria-checked')).toBe('false')
    w.unmount()
  })

  it('浮层内开关：未授权 ⇒ 写回服务端 auto；已授权 ⇒ 写回 manual（收回路径同处）', async () => {
    const w = mountControl()
    await w.find('[data-testid="auto-approve-chip"]').trigger('click')
    await w.find('[data-testid="auto-approve-panel-switch"]').trigger('click')
    expect(h.calls).toEqual([true])
    w.unmount()

    h.authorized = true
    h.calls.length = 0
    const w2 = mountControl()
    await w2.find('[data-testid="auto-approve-chip"]').trigger('click')
    const sw = w2.find('[data-testid="auto-approve-panel-switch"]')
    expect(sw.attributes('aria-checked')).toBe('true')
    await sw.trigger('click')
    expect(h.calls).toEqual([false])
    w2.unmount()
  })

  it('PC 已授权：胶囊 is-on + 图形实心（状态一眼可读）', () => {
    h.authorized = true
    const w = mountControl()
    const chip = w.find('[data-testid="auto-approve-chip"]')
    expect(chip.classes()).toContain('is-on')
    expect(w.find('svg.auto-approve-glyph').classes()).toContain('is-on')
    w.unmount()
  })

  it('移动端：icon-only 触发器（零文字标签）+ 点击开底部 Sheet（同一份面板）', async () => {
    const w = mountControl({ desktop: false })
    expect(w.find('[data-testid="auto-approve-chip"]').exists()).toBe(false)
    const trigger = w.find('[data-testid="auto-approve-trigger"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toBe('')
    await trigger.trigger('click')
    expect(w.find('.stub-sheet').exists()).toBe(true)
    expect(w.find('[data-testid="auto-approve-panel-switch"]').exists()).toBe(true)
    w.unmount()
  })

  it('只读画布：触发器禁用（不得改账号级偏好）', () => {
    const w = mountControl({ readOnly: true })
    expect(w.find('[data-testid="auto-approve-chip"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })
})
