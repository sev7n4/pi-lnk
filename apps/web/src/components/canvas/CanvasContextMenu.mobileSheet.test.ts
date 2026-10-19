import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CanvasContextMenu from './CanvasContextMenu.vue'

/**
 * 移动端上下文动作 sheet（2026-10-19 D-6）：44px 行高（CSS 契约）、
 * 「重命名 / 多选」两项补齐、danger 置底、遮罩点按仅收起不触发动作。
 * PC 右键小浮层保持原样（mobile=false 分支）。
 * 注：sheet 走 Teleport to body —— 查询落在 document.body，不在 wrapper 树内。
 */
describe('CanvasContextMenu：移动端动作 sheet（PR1）', () => {
  const baseProps = {
    x: 0,
    y: 0,
    nodeId: 'node-1',
    nodeType: 'image',
    nodeTitle: '我的图片',
    hasUrl: true,
    mediaKind: 'image',
  }

  function mountSheet(extra: Record<string, unknown> = {}) {
    return mount(CanvasContextMenu, {
      props: { ...baseProps, mobile: true, ...extra },
      attachTo: document.body,
    })
  }

  function sheetLabels() {
    return Array.from(document.body.querySelectorAll('.ctx-sheet-item')).map((el) => el.textContent ?? '')
  }

  it('mobile=true 渲染底部 sheet：含重命名/多选，删除置底', () => {
    const w = mountSheet()
    const labels = sheetLabels()
    expect(labels, '重命名必须补齐（P0-4）').toContain('重命名')
    expect(labels, '多选入口（D-4）').toContain('多选')
    expect(labels[labels.length - 1], 'danger 置底').toBe('删除节点')
    expect(document.body.querySelector('.ctx-sheet-title')?.textContent).toBe('我的图片')
    w.unmount()
  })

  it('行高契约：CSS 中 ctx-sheet-item min-height 44px（D-7）', () => {
    const fs = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'CanvasContextMenu.vue'),
      'utf8',
    )
    const scope = fs.match(/\.ctx-sheet-item\s*\{[^}]*\}/)?.[0] ?? ''
    expect(scope, '找不到 sheet 行规则块').toBeTruthy()
    expect(scope).toContain('min-height: 44px')
  })

  it('点「重命名」emit action=rename', async () => {
    const w = mountSheet()
    const btn = Array.from(document.body.querySelectorAll('.ctx-sheet-item')).find(
      (el) => el.textContent === '重命名',
    ) as HTMLElement
    btn.click()
    await w.vm.$nextTick()
    expect(w.emitted('action')?.[0]).toEqual(['rename', undefined])
    w.unmount()
  })

  it('点「多选」emit action=multi-select', async () => {
    const w = mountSheet()
    const btn = Array.from(document.body.querySelectorAll('.ctx-sheet-item')).find(
      (el) => el.textContent === '多选',
    ) as HTMLElement
    btn.click()
    await w.vm.$nextTick()
    expect(w.emitted('action')?.[0]).toEqual(['multi-select', undefined])
    w.unmount()
  })

  it('遮罩点按仅收起：emit close 但不 emit action', async () => {
    const w = mountSheet()
    ;(document.body.querySelector('.ctx-sheet-scrim') as HTMLElement).click()
    await w.vm.$nextTick()
    expect(w.emitted('action')).toBeUndefined()
    expect(w.emitted('close')?.length).toBe(1)
    w.unmount()
  })

  it('条件项按节点类型显隐：group 出解组、非 group 出引用与副本', () => {
    const group = mountSheet({ nodeType: 'group' })
    const groupLabels = sheetLabels()
    expect(groupLabels).toContain('解组')
    expect(groupLabels).not.toContain('加入 Agent 引用')
    group.unmount()

    const image = mountSheet()
    const labels = sheetLabels()
    expect(labels).toContain('加入 Agent 引用')
    expect(labels).toContain('新建副本')
    expect(labels).toContain('新建副本（含上游）')
    image.unmount()
  })

  it('mobile=false 走 PC 小浮层（原行为）：popover 渲染、无 sheet', () => {
    const w = mount(CanvasContextMenu, { props: baseProps, attachTo: document.body })
    expect(w.find('.neo-popover').exists(), 'PC 右键浮层保留').toBe(true)
    expect(document.body.querySelector('.ctx-sheet'), 'PC 不渲染 sheet').toBeNull()
    // PC 浮层不补重命名/多选（PC 双击改名 + Shift 点选沿用旧姿势）
    const labels = Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent ?? '')
    expect(labels).not.toContain('重命名')
    expect(labels).not.toContain('多选')
    w.unmount()
  })
})
