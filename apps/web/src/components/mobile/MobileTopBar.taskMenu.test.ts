// MobileTopBar 顶栏结构契约（原「⋯ 菜单任务动态项」测试；2026-10-30 ⋯ 菜单整体移除）：
// ⚠️ 2026-10-30 用户裁决：⋯ 项目菜单（发布/导出/导入/任务，chat+canvas 共用）整体移除，
// 入口后续统一重新规划（规格 v5）——本文件转而锁定「菜单退场 + 返回/⤢ 仍可达 + 触控契约」。
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
// ‹ 返回创作空间（go-gallery）+ 项目名；画布额外 ⤢。品牌字标回城 / 新对话 / 历史
// 等冗余回城与入口已退役（单一返回路径 + ADR-0015 单对话模型）。
describe('MobileTopBar：对话/画布同构（规格 §6.2/§6.3）', () => {
  it('对话页签：单一返回路径 ‹ 返回创作空间（go-gallery）+ 项目名；无品牌字标 / 无「新对话」', async () => {
    const wrapper = mountBar({ tab: 'chat' })
    expect(q('[data-testid="mobile-topbar-back"]')).not.toBeNull()
    expect(q('[data-testid="mobile-topbar-project-name"]')).not.toBeNull()
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

describe('MobileTopBar：⋯ 项目菜单整体移除（2026-10-30）', () => {
  it('菜单按钮与菜单体退场（chat / canvas 均不挂菜单）', async () => {
    const chat = mountBar({ tab: 'chat' })
    expect(q('[data-testid="mobile-topbar-menu"]')).toBeNull()
    expect(q('.bar-menu')).toBeNull()
    chat.unmount()
    const canvas = mountBar({ tab: 'canvas' })
    expect(q('[data-testid="mobile-topbar-menu"]')).toBeNull()
    expect(q('.bar-menu')).toBeNull()
    canvas.unmount()
  })

  it('项目操作项与任务动态项文案零命中；emits/props 一并下线', async () => {
    const wrapper = mountBar({ tab: 'canvas', hasTaskHistory: true, taskActiveCount: 2 })
    await flushPromises()
    expect(document.body.textContent).not.toContain('发布作品')
    expect(document.body.textContent).not.toContain('导入工作流')
    expect(document.body.textContent).not.toContain('导出工作流')
    expect(wrapper.emitted('open-tasks')).toBeUndefined()
    wrapper.unmount()
    const sfc = readFileSync(join(here, 'MobileTopBar.vue'), 'utf8')
    expect(sfc).not.toContain('bar-menu-task')
    expect(sfc).not.toContain('bar-menu-export')
    expect(sfc).not.toContain('taskActiveCount')
    expect(sfc).not.toContain('hasTaskHistory')
    expect(sfc).not.toContain("'open-tasks': []")
  })

  it('触控契约：bar-btn 隐形热区 inset:-5px（返回/⤢ 沿用同一钮型）', () => {
    const sfc = readFileSync(join(here, 'MobileTopBar.vue'), 'utf8')
    expect(sfc).toMatch(/\.bar-btn::after\s*\{[^}]*inset:\s*-5px/)
  })
})
