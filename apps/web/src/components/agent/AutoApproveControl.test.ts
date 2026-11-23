import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AutoApproveControl from './AutoApproveControl.vue'

/**
 * 授权自动生成 · composer 入口（规格 2026-11-22-generation-auto-approve-gate-design §11 / §12 / §13）。
 *
 * 契约（用户拍板）：
 * 1. 胶囊 = 图形 + **`Auto` 短标记** + 箭头（PC）；**胶囊上不出现中文长文案**，
 *    「自动生成 / 每次先问」下沉到浮层卡片（`AutoApprovePanel`）说明；
 * 2. 开启态 = 实心图形 + `Auto` 琥珀字，**既无描边也无柔底**（§12 Q1 去描边、§13 Q1 去柔底）；
 * 3. 关闭态 = 线框图形、**零文字**、无底无框；
 * 4. 点击**开浮层**（不是直接收回）——双向操作都在浮层里的开关上；
 * 5. 浮层承载**作用域说明**（图片与音频免确认 / 视频仍逐次确认）+ 一个 `role=switch` 开关；
 * 6. **移动端与 PC 同一枚胶囊**（§12，取代 §11 的 icon-only 分支）+ 底部 Sheet（同一份面板）；
 * 7. 开关动作写回服务端（`setAuthorized`），组件自身不做本地判定、不缓存。
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
    // ⚠️ 必须 attachTo：VTU 默认挂在 detached 容器里 ⇒ 事件传播路径不含 document
    //    ⇒ §14 防线 B 的 document 级捕获监听收不到 pointerdown（守卫会假绿）。
    attachTo: document.body,
  })
}

beforeEach(() => {
  h.authorized = false
  h.calls.length = 0
})

describe('AutoApproveControl — composer 入口', () => {
  it('PC 未授权：胶囊常驻（图形，**零文字**），图形线框，浮层默认关闭', () => {
    const w = mountControl()
    const chip = w.find('[data-testid="auto-approve-chip"]')
    expect(chip.exists()).toBe(true)
    // §12：关闭态不得出现任何文字（尤其不得出现「自动生成」——那是低对比度的功能名，读不出状态）
    expect(chip.text()).toBe('')
    expect(chip.text()).not.toContain('自动生成')
    expect(chip.classes()).not.toContain('is-on')
    expect(w.find('svg.auto-approve-glyph').classes()).not.toContain('is-on')
    expect(w.find('[data-testid="auto-approve-chip-auto"]').exists()).toBe(false)
    expect(w.find('[data-testid="auto-approve-popover"]').exists()).toBe(false)
    w.unmount()
  })

  it('PC 已授权：胶囊 is-on + 实心图形 + `Auto` 短标记（无中文长文案）', () => {
    h.authorized = true
    const w = mountControl()
    const chip = w.find('[data-testid="auto-approve-chip"]')
    expect(chip.classes()).toContain('is-on')
    expect(w.find('svg.auto-approve-glyph').classes()).toContain('is-on')
    const auto = w.find('[data-testid="auto-approve-chip-auto"]')
    expect(auto.exists()).toBe(true)
    expect(auto.text()).toBe('Auto')
    // 长文案不得回到胶囊上
    expect(chip.text()).not.toContain('自动生成')
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

  it('移动端：**与 PC 同一枚胶囊**（非 icon-only）+ 点击开底部 Sheet（同一份面板）', async () => {
    const w = mountControl({ desktop: false })
    // 同一枚胶囊（不再是独立 icon-only 分支）
    const chip = w.find('[data-testid="auto-approve-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.classes()).toContain('is-mobile')
    expect(w.find('[data-testid="auto-approve-trigger"]').exists()).toBe(false)
    // 移动端关闭态同样零文字
    expect(chip.text()).toBe('')
    // 移动端**不带箭头**（箭头语义与底部 Sheet 相反）
    expect(w.find('.auto-approve-chip-caret').exists()).toBe(false)
    await chip.trigger('click')
    expect(w.find('.stub-sheet').exists()).toBe(true)
    expect(w.find('[data-testid="auto-approve-panel-switch"]').exists()).toBe(true)
    w.unmount()
  })

  it('移动端已授权：同一枚胶囊显示 `Auto`，仍无中文长文案', () => {
    h.authorized = true
    const w = mountControl({ desktop: false })
    const chip = w.find('[data-testid="auto-approve-chip"]')
    expect(chip.find('[data-testid="auto-approve-chip-auto"]').text()).toBe('Auto')
    expect(chip.text()).not.toContain('自动生成')
    w.unmount()
  })

  it('只读画布：触发器禁用（不得改账号级偏好）', () => {
    const w = mountControl({ readOnly: true })
    expect(w.find('[data-testid="auto-approve-chip"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  /* ---- §14 防误弹三道防线（真机走查：收缩态点输入框 ⇒ 凭空弹出设置卡片）---- */

  it('§14-A 收缩态（collapsed）**入口本体不渲染**（DOM 级，不是 CSS 隐藏）', () => {
    const w = mountControl({ collapsed: true })
    // 防线 A：收缩态 DOM 里**不存在** chip ⇒ 没有任何可命中目标
    expect(w.find('[data-testid="auto-approve-chip"]').exists()).toBe(false)
    expect(w.find('[data-testid="auto-approve-chip-auto"]').exists()).toBe(false)
    expect(w.find('.auto-approve-glyph').exists()).toBe(false)
    // 根容器保留（防线 B 要它常驻记录 pointerdown），但带 is-collapsed 消除占位
    const root = w.find('[data-testid="auto-approve-control"]')
    expect(root.exists()).toBe(true)
    expect(root.classes()).toContain('is-collapsed')
    w.unmount()
  })

  it('§14-B 意图守卫：pointerdown 落在别处 ⇒ 落在 chip 上的 click **被忽略**（不弹卡片）', async () => {
    const w = mountControl({ desktop: false })
    // 模拟「点输入框/提示语」：pointerdown 落在组件之外（target 不在 chip 内）
    await w.find('[data-testid="auto-approve-control"]').trigger('pointerdown')
    // 随后 click 却落在 chip 上（真机 touchend 落点判定 → 形态切换后 chip 滑到落点下）
    await w.find('[data-testid="auto-approve-chip"]').trigger('click')
    expect(w.find('.stub-sheet').exists()).toBe(false)
    expect(w.find('[data-testid="auto-approve-popover"]').exists()).toBe(false)
    w.unmount()
  })

  it('§14-B 正常点击仍可用：pointerdown 落在 chip 内 ⇒ click 打开卡片', async () => {
    const w = mountControl({ desktop: false })
    await w.find('[data-testid="auto-approve-chip"]').trigger('pointerdown')
    await w.find('[data-testid="auto-approve-chip"]').trigger('click')
    expect(w.find('.stub-sheet').exists()).toBe(true)
    w.unmount()
  })

  it('§14-B 键盘激活（无 pointerdown）仍可打开卡片（无障碍不可被守卫误伤）', async () => {
    const w = mountControl({ desktop: false })
    // 直接 click、不带任何 pointerdown ⇒ 视为键盘/程序化激活 ⇒ 放行
    await w.find('[data-testid="auto-approve-chip"]').trigger('click')
    expect(w.find('.stub-sheet').exists()).toBe(true)
    w.unmount()
  })

  it('§14-B 时间窗之外 ⇒ 放行（很久前在别处点过鼠标，不该误伤后续键盘激活）', async () => {
    const w = mountControl({ desktop: false })
    await w.find('[data-testid="auto-approve-control"]').trigger('pointerdown')
    // 真实等待越过意图窗（500ms）⇒ 这次 click 与那次 pointerdown 无关
    await new Promise((r) => setTimeout(r, 600))
    await w.find('[data-testid="auto-approve-chip"]').trigger('click')
    expect(w.find('.stub-sheet').exists()).toBe(true)
    w.unmount()
  })

  it('§14-B **PC 端不启用守卫**（PC 无收缩态 ⇒ 无误弹风险，且不得误伤键盘用户）', async () => {
    const w = mountControl({ desktop: true })
    // 鼠标点过别处（落点不在 chip 内）⇒ PC 端仍应正常打开
    await w.find('[data-testid="auto-approve-control"]').trigger('pointerdown')
    await w.find('[data-testid="auto-approve-chip"]').trigger('click')
    expect(w.find('[data-testid="auto-approve-popover"]').exists()).toBe(true)
    w.unmount()
  })

  it('§14-C 转为收缩态 ⇒ 复位 open（Sheet 不跨形态残留）', async () => {
    const w = mountControl({ desktop: false })
    await w.find('[data-testid="auto-approve-chip"]').trigger('click')
    expect(w.find('.stub-sheet').exists()).toBe(true)
    await w.setProps({ collapsed: true })
    expect(w.find('.stub-sheet').exists()).toBe(false)
    w.unmount()
  })
})
