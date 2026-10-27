// MobileTopBar 画布态 ⋯ 菜单任务动态项（2026-10-19 D-2 入口收敛）：
// 无任务不出现；运行中/排队带计数；点按 emit open-tasks；对话页签永不出现。
// 触控契约（菜单项 44px / bar-btn 隐形热区）走静态断言。
import { describe, expect, it, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileTopBar from './MobileTopBar.vue'

const here = dirname(fileURLToPath(import.meta.url))

function mountBar(props: Record<string, unknown> = {}) {
  return mount(MobileTopBar, {
    props: { tab: 'canvas', projectName: '测试项目', ...props },
    attachTo: document.body,
  })
}

function q(selector: string): HTMLElement | null {
  return document.body.querySelector(selector)
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

// 规格 §6.2/§6.3（mobile-web-three-page-topbar-redesign）：对话/画布顶栏同构——
// ‹ 返回创作空间（go-gallery）+ 项目名 + ⋯；画布额外 ⤢。品牌字标回城 / 新对话 / 历史
// 等冗余回城与入口已退役（单一返回路径 + ADR-0015 单对话模型）。
describe('MobileTopBar：对话/画布同构（规格 §6.2/§6.3）', () => {
  it('对话页签：单一返回路径 ‹ 返回创作空间（go-gallery）+ 项目名 + ⋯；无品牌字标 / 无「新对话」', async () => {
    const wrapper = mountBar({ tab: 'chat' })
    expect(q('[data-testid="mobile-topbar-back"]')).not.toBeNull()
    expect(q('[data-testid="mobile-topbar-project-name"]')).not.toBeNull()
    expect(q('[data-testid="mobile-topbar-menu"]')).not.toBeNull()
    // 品牌字标回城已退役（只剩单一返回路径）
    expect(q('[data-testid="mobile-topbar-brand"]')).toBeNull()
    // 新对话入口已退役（ADR-0015 单对话模型；建/切对话收口到创作空间与移动端顶栏）
    expect(document.body.textContent).not.toContain('新对话')
    const back = q('[data-testid="mobile-topbar-back"]')!
    back.click()
    await flushPromises()
    expect(wrapper.emitted('go-gallery')).toHaveLength(1)
    wrapper.unmount()
  })

  it('画布页签：额外 ⤢ 适应画布（fit-view），同一返回路径', async () => {
    const wrapper = mountBar({ tab: 'canvas' })
    expect(q('[data-testid="mobile-topbar-fit"]')).not.toBeNull()
    const fit = q('[data-testid="mobile-topbar-fit"]')!
    fit.click()
    await flushPromises()
    expect(wrapper.emitted('fit-view')).toHaveLength(1)
    wrapper.unmount()
  })

  it('画布页签不渲染品牌字标（字标回城已退役）', () => {
    const wrapper = mountBar({ tab: 'canvas' })
    expect(q('[data-testid="mobile-topbar-brand"]')).toBeNull()
    wrapper.unmount()
  })
})

describe('MobileTopBar：⋯ 菜单任务动态项（PR2）', () => {
  it('无任务记录 → 菜单项不出现', async () => {
    const wrapper = mountBar({ hasTaskHistory: false, taskActiveCount: 0 })
    q('.bar-btn[aria-label="项目菜单"]')!.click()
    await flushPromises()
    expect(q('[data-testid="bar-menu-task"]')).toBeNull()
    wrapper.unmount()
  })

  it('有任务 + 运行中 2 → 「任务（2）」，点按 emit open-tasks', async () => {
    const wrapper = mountBar({ hasTaskHistory: true, taskActiveCount: 2 })
    q('.bar-btn[aria-label="项目菜单"]')!.click()
    await flushPromises()
    const item = q('[data-testid="bar-menu-task"]')
    expect(item).not.toBeNull()
    expect(item!.textContent).toContain('任务（2）')
    item!.click()
    await flushPromises()
    expect(wrapper.emitted('open-tasks')).toHaveLength(1)
    wrapper.unmount()
  })

  it('仅有历史无运行中 → 纯「任务」文案（仍可达，不成死角）', async () => {
    const wrapper = mountBar({ hasTaskHistory: true, taskActiveCount: 0 })
    q('.bar-btn[aria-label="项目菜单"]')!.click()
    await flushPromises()
    const item = q('[data-testid="bar-menu-task"]')
    expect(item!.textContent?.trim()).toBe('任务')
    wrapper.unmount()
  })

  it('对话页签：即使有任务也不出现（任务语义只属画布）', async () => {
    const wrapper = mountBar({ tab: 'chat', hasTaskHistory: true, taskActiveCount: 3 })
    await flushPromises()
    expect(q('[data-testid="bar-menu-task"]')).toBeNull()
    wrapper.unmount()
  })

  it('触控契约：菜单项 min-height 44px；bar-btn 隐形热区 inset:-5px', () => {
    const sfc = readFileSync(join(here, 'MobileTopBar.vue'), 'utf8')
    expect(sfc).toMatch(/\.bar-menu-item\s*\{[^}]*min-height:\s*var\(--lnk-touch-target\)/)
    expect(sfc).toMatch(/\.bar-btn::after\s*\{[^}]*inset:\s*-5px/)
  })
})
