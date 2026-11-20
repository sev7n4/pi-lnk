// 移动端画布「＋ FAB」（2026-10-19 D-2）：唯一新建入口，48px 圆 + accent 渐变；
// 空画布呼吸类 + 触控契约走静态断言（jsdom 不计算 scoped CSS）。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileCanvasCreateFab from './MobileCanvasCreateFab.vue'

const here = dirname(fileURLToPath(import.meta.url))

describe('MobileCanvasCreateFab（PR2）', () => {
  it('点击 → emit click（开新建 sheet）', async () => {
    const wrapper = mount(MobileCanvasCreateFab)
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('空画布 breathe=true 挂呼吸类；非空不挂', () => {
    const w1 = mount(MobileCanvasCreateFab, { props: { breathe: true } })
    expect(w1.find('button').classes()).toContain('is-breathing')
    const w2 = mount(MobileCanvasCreateFab, { props: { breathe: false } })
    expect(w2.find('button').classes()).not.toContain('is-breathing')
  })

  it('2026-11-20：右下角落位 + 上移 12px；anchor=safe 只让开安全区（创作空间）', () => {
    const sfc = readFileSync(join(here, 'MobileCanvasCreateFab.vue'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(sfc).toContain('right: 12px')
    expect(sfc).not.toContain('left: 12px')
    expect(sfc).toMatch(/bottom:\s*calc\(var\(--lnk-tabbar-h, 0px\) \+ env\(safe-area-inset-bottom, 0px\) \+ 12px\)/)
    expect(sfc).toMatch(/\.mobile-create-fab\.is-safe-anchored\s*\{[^}]*env\(safe-area-inset-bottom, 0px\) \+ 12px/)
    const project = mount(MobileCanvasCreateFab, {
      props: { anchor: 'safe', label: '新建项目', testId: 'canvases-create-fab' },
    })
    expect(project.find('button').attributes('aria-label')).toBe('新建项目')
    expect(project.find('button').attributes('data-testid')).toBe('canvases-create-fab')
    expect(project.find('button').classes()).toContain('is-safe-anchored')
  })

  it('契约：48px ≥44px、清位公式锚页签栏（tabbar/safe-area）、:active scale(0.92)', () => {
    // 剥注释再断言（迁移说明写在注释里是规范，否定断言命中注释 = 假红）
    const sfc = readFileSync(join(here, 'MobileCanvasCreateFab.vue'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(sfc).toMatch(/width:\s*48px/)
    expect(sfc).toMatch(/height:\s*48px/)
    // 2026-10-21 真机走查：FAB 与对话裸条**并排**（裸条左移 56px 让开）⇒ 落位只锚
    // 页签栏 + 安全区；不再消费 --lnk-agent-dock-h（画布视图里它是"贴底容器"高度，
    // 实测不可靠 ⇒ 曾把 FAB 压到裸条上、只剩一个紫色月牙）。
    expect(sfc).not.toContain('var(--lnk-agent-dock-h, 0px)')
    expect(sfc).toContain('var(--lnk-tabbar-h, 0px)')
    expect(sfc).toContain('env(safe-area-inset-bottom, 0px)')
    expect(sfc).toMatch(/\.mobile-create-fab:active\s*\{[^}]*scale\(0\.92\)/)
  })
})
