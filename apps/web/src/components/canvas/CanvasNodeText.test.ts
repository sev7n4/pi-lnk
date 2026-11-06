import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import {
  CANVAS_NODE_PATCH_KEY,
  CANVAS_NODE_READONLY_KEY,
} from '@/composables/canvasNodeActions'

vi.mock('@vue-flow/core', async () => {
  const { defineComponent, h } = await import('vue')
  const Handle = defineComponent({
    name: 'Handle',
    setup: (_, { slots }) => () => h('div', { class: 'mock-handle' }, slots.default?.()),
  })
  return {
    Handle,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNode: () => ({ id: 'node-1' }),
    useNodeId: () => 'node-1',
    useVueFlow: () => ({ updateNodeData: vi.fn() }),
  }
})

vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }) }))

import CanvasNodeText from './CanvasNodeText.vue'

const BASE = { content: '普通文本', label: '节点' }

function mountNode(data: Record<string, unknown>, providers: Record<symbol, unknown> = {}) {
  return mount(CanvasNodeText, {
    props: { data } as never,
    global: { provide: providers },
  })
}

/**
 * CanvasNodeText format 分支（规格 §4.2/§4.7）：
 * format==='html' ⇒ 徽章 + 摘要卡 + 双击沙箱预览（保存走 patch）；
 * 无 format / 非法 format ⇒ 既有路径零回归。
 */
describe('CanvasNodeText format 分支（规格 §4.2/§4.7）', () => {
  it('无 format ⇒ 既有路径：无双击预览语义、显示原文案', () => {
    const w = mountNode(BASE)
    expect(w.find('.neo-text-card--html').exists()).toBe(false)
    expect(w.text()).toContain('普通文本')
  })

  it("format:'html' ⇒ HTML 徽章 + 摘要，不渲染全文", () => {
    const w = mountNode({
      content: '<html><title>落地页</title><body>很长很长的正文</body></html>',
      format: 'html',
    })
    expect(w.find('.neo-html-badge').text()).toBe('HTML')
    expect(w.text()).toContain('落地页')
    expect(w.text()).not.toContain('很长很长的正文')
  })

  it('format 非法值 ⇒ 按 plain 走既有路径（fail-soft）', () => {
    const w = mountNode({ ...BASE, format: 'jsx' })
    expect(w.find('.neo-text-card--html').exists()).toBe(false)
  })

  it('只读注入 ⇒ 双击不开预览', async () => {
    const w = mountNode({ content: '<p>x</p>', format: 'html' }, {
      [CANVAS_NODE_READONLY_KEY as symbol]: true,
    })
    await w.find('.neo-text-card--html').trigger('dblclick')
    expect(w.findComponent({ name: 'HtmlNodePreview' }).exists()).toBe(false)
  })

  it('预览保存 ⇒ emit 的 payload 走 patch（html payload 透传）', async () => {
    const patch = vi.fn()
    const w = mountNode({ content: '<p>x</p>', format: 'html' }, {
      [CANVAS_NODE_PATCH_KEY as symbol]: patch,
    })
    await w.find('.neo-text-card--html').trigger('dblclick')
    w.findComponent({ name: 'HtmlNodePreview' }).vm.$emit('save', {
      content: '<p>y</p>',
      format: 'html',
    })
    await nextTick()
    expect(patch).toHaveBeenCalledWith(expect.any(String), {
      content: '<p>y</p>',
      format: 'html',
    })
  })
})

/**
 * Task 7（spec 2026-11-05-canvas-digest §10 风险#1）：digest 节点只读分支——
 * 用户编辑会被下轮系统翻新覆盖，故 digest ⇒ 预览强制 readonly + 「总览」徽章。
 */
describe('CanvasNodeText digest 只读分支（Task 7）', () => {
  it("digest ⇒ 「总览」徽章替换 HTML 徽章", () => {
    const w = mountNode({ content: '<p>x</p>', format: 'html', digest: true, source: 'system-digest' })
    expect(w.text()).toContain('总览')
    expect(w.find('.neo-html-badge').text()).toBe('总览')
  })

  it('digest ⇒ 打开预览时 HtmlNodePreview 为 readonly', async () => {
    const w = mountNode({ content: '<p>x</p>', format: 'html', digest: true, source: 'system-digest' })
    await w.find('.neo-text-card--html').trigger('dblclick')
    await nextTick()
    const preview = w.findComponent({ name: 'HtmlNodePreview' })
    expect(preview.props('readonly')).toBe(true)
    expect(preview.props('trusted')).toBe(true)
  })

  it('非 digest html 节点不受影响：HTML 徽章 + preview 可编辑', async () => {
    const w = mountNode({ content: '<p>x</p>', format: 'html' })
    expect(w.find('.neo-html-badge').text()).toBe('HTML')
    await w.find('.neo-text-card--html').trigger('dblclick')
    await nextTick()
    const preview = w.findComponent({ name: 'HtmlNodePreview' })
    expect(preview.props('readonly')).toBe(false)
  })

  it('digest 且 format 丢失（脏数据）⇒ 沉浸编辑器不打开、写回被拦', async () => {
    const patch = vi.fn()
    const w = mountNode({ content: '旧文本', digest: true, source: 'system-digest' }, {
      [CANVAS_NODE_PATCH_KEY as symbol]: patch,
    })
    const editor = w.findComponent({ name: 'PromptMarkdownEditor' })
    expect(editor.exists()).toBe(true)
    expect(editor.props('visible')).toBe(false)
    await w.find('.neo-text-card').trigger('dblclick')
    await nextTick()
    expect(editor.props('visible')).toBe(false)
    editor.vm.$emit('save', '用户改动')
    await nextTick()
    expect(patch).not.toHaveBeenCalled()
    w.unmount()
  })
})
