import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANVAS_NODE_RENAME_KEY } from '@/composables/canvasNodeActions'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..', '..')

vi.mock('@vue-flow/core', async () => {
  const { defineComponent, h } = await import('vue')
  const Handle = defineComponent({
    name: 'Handle',
    setup: (_, { slots }) => () => h('div', { class: 'mock-handle' }, slots.default?.()),
  })
  return {
    Handle,
    Position: { Top: 'top', Bottom: 'bottom' },
    useNode: () => ({ id: 'group-1' }),
    useVueFlow: () => ({ updateNodeData: vi.fn() }),
  }
})

import CanvasNodeGroup from './CanvasNodeGroup.vue'

const renameFn = vi.fn()

function mountGroup(data: Record<string, unknown>, selected = false) {
  return mount(CanvasNodeGroup, {
    props: { selected, data: data as never },
    global: { provide: { [CANVAS_NODE_RENAME_KEY as symbol]: renameFn } },
  })
}

beforeEach(() => renameFn.mockClear())
afterEach(() => renameFn.mockClear())

/**
 * 分组节点视觉重构回归锁（2026-10-12，P3）。
 *
 * 用户口径：① 分组内部不该内嵌实体小卡（分组徽标 + 名称 + 计数 + 拖拽说明），
 * 信息应收成贴上沿的无底信息条；② 默认色不该是品牌紫（主色紫色占比已过高）；
 * ③ 分组色应可自定义色卡，默认与画布仅数个百分点明度差。
 *
 * jsdom 无布局引擎 —— 外形层断言落在：DOM 结构（徽标/说明文案不得复活）、
 * `--neo-group-accent` 注入值、以及 neo-node.css 规则层（紫色 rgba 清零 +
 * 容器规则消费 accent 令牌）。
 */
describe('CanvasNodeGroup：信息条外沿化（拆内嵌小卡）', () => {
  it('有效性前置：信息条渲染名称与节点数', () => {
    const w = mountGroup({ title: '分组 0', childIds: ['a', 'b'] })
    const strip = w.find('.group-drag-handle')
    expect(strip.exists(), '信息条必须渲染').toBe(true)
    expect(strip.text()).toContain('分组 0')
    expect(strip.text()).toContain('2 个节点')
    w.unmount()
  })

  it('内嵌卡要素不得复活：无「分组」徽标、无「拖此栏移动整组」说明', () => {
    const w = mountGroup({ title: '我的分组', childIds: ['a'] })
    // 旧徽标 = 独立的「分组」二字 span；新信息条只有「{名称}」+「N 个节点」
    const badges = w.findAll('span').filter((s) => s.text() === '分组')
    expect(badges, '「分组」徽标不得复活').toEqual([])
    expect(w.text()).not.toContain('拖此栏移动整组')
    w.unmount()
  })

  it('信息条无卡感：结构层不再有独立边框/底色类（旧 .group-drag-handle 卡样式在全局 css 已收窄为无底信息条）', () => {
    const css = readFileSync(join(WEB, 'src', 'styles', 'neo-node.css'), 'utf8')
    expect(css).not.toContain('rgba(24, 24, 27, 0.72)')
    expect(css).not.toContain('backdrop-filter: blur(8px)')
  })

  it('改名流保留：双击出输入框，回车提交 renameNode', async () => {
    const w = mountGroup({ title: '分组 0', childIds: ['a'] })
    await w.find('.group-drag-handle').trigger('dblclick')
    const input = w.find('.group-rename-input')
    expect(input.exists(), '双击后应出现改名输入框').toBe(true)
    await input.setValue('新名字')
    await input.trigger('keydown.enter.stop')
    expect(renameFn).toHaveBeenCalledWith('group-1', '新名字')
    w.unmount()
  })
})

describe('CanvasNodeGroup：色卡注入与默认去紫', () => {
  it('colorKey=moss → 根节点注入 --neo-group-accent: var(--neo-group-moss)', () => {
    const w = mountGroup({ title: 'g', childIds: [], colorKey: 'moss' })
    const style = w.find('.group-node-wrapper').attributes('style') ?? ''
    expect(style).toContain('--neo-group-accent')
    expect(style).toContain('var(--neo-group-moss)')
    w.unmount()
  })

  it('非法 colorKey 与缺省 → 落 neutral（旧分组天然兼容）', () => {
    for (const data of [{ colorKey: 'rainbow' }, {}]) {
      const w = mountGroup(data)
      const style = w.find('.group-node-wrapper').attributes('style') ?? ''
      expect(style).toContain('var(--neo-group-neutral)')
      w.unmount()
    }
  })

  it('CSS 规则层：分组规则块品牌紫清零，容器背景/虚线边消费 --neo-group-accent', () => {
    const css = readFileSync(join(WEB, 'src', 'styles', 'neo-node.css'), 'utf8')
    // 范围边界：本断言只锁**分组相关规则块**——文件里其他历史品牌紫内联
    // （如 dock 氛围光斑）属清扫系列已裁定的内容性保留，不在本锁射程。
    const groupScopes = css.match(/\.group-node[a-z.-]*(?:\s*\.[a-z-]+)*\s*\{[^}]*\}/g) ?? []
    expect(groupScopes.length, '守卫自身：分组规则块应能匹配到').toBeGreaterThan(2)
    for (const scope of groupScopes) {
      expect(scope, '分组规则块内不得再出现品牌紫硬编码').not.toContain('109, 93, 252')
    }
    const block = css.match(/\.group-node-container\s*\{[^}]*\}/)?.[0]
    expect(block, '找不到分组容器规则块').toBeTruthy()
    expect(block).toContain('--neo-group-accent')
    expect(block).toContain('color-mix')
    const active = css.match(/\.group-node-wrapper\.is-active \.group-node-container\s*\{[^}]*\}/)?.[0]
    expect(active, '选中态规则块').toBeTruthy()
    expect(active).not.toContain('--neo-hi-text')
  })

  it('色卡令牌两主题成对：neowow-tokens 深浅块各有 8 个 --neo-group-*', () => {
    const css = readFileSync(join(WEB, 'src', 'styles', 'neowow-tokens.css'), 'utf8')
    const at = css.indexOf(":root[data-theme='light']")
    expect(at, '找不到浅色块').toBeGreaterThan(0)
    const count = (scope: string) => (scope.match(/--neo-group-[a-z]+:/g) ?? []).length
    expect(count(css.slice(0, at))).toBe(8)
    expect(count(css.slice(at))).toBe(8)
  })
})
