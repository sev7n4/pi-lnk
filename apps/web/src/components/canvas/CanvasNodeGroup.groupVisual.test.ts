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
describe('CanvasNodeGroup：标题前分组图标（2026-10-13）', () => {
  it('有效性前置：标题条渲染分组图标（svg）且无文字徽标', () => {
    const w = mountGroup({ title: '分组 1', childIds: ['a'] })
    const icon = w.find('.group-title-icon')
    expect(icon.exists(), '分组图标必须渲染').toBe(true)
    expect(icon.find('svg').exists(), '图标应为 svg').toBe(true)
    expect(icon.text(), '图标不得携带文字（避免复活旧「分组」徽标）').toBe('')
    w.unmount()
  })

  it('图标颜色跟随分组背景色：CSS 消费 --neo-group-accent，svg 用 currentColor 继承', () => {
    const fs = readFileSync(join(HERE, 'CanvasNodeGroup.vue'), 'utf8')
    const iconScope = fs.match(/(?:^|\n)\.group-title-icon\s*\{[^}]*\}/)?.[0] ?? ''
    expect(iconScope, '找不到分组图标规则块').toBeTruthy()
    expect(iconScope, '图标色应跟随分组色（与色卡当前色一致）').toContain('var(--neo-group-accent)')
    // svg stroke=currentColor ⇒ 颜色由 .group-title-icon 的 color 继承
    const svgTag = fs.match(/<svg[^>]*stroke="currentColor"[^>]*>/)?.[0] ?? ''
    expect(svgTag, '图标 svg 应以 currentColor 描边').toContain('stroke="currentColor"')
    // DOM 层：moss 分组下 wrapper 注入的 accent 链完整（图标消费同一变量）
    const w = mountGroup({ title: 'g', childIds: [], colorKey: 'moss' })
    const style = w.find('.group-node-wrapper').attributes('style') ?? ''
    expect(style).toContain('var(--neo-group-moss)')
    w.unmount()
  })

  it('图标位于标题之前（速识位），不侵占容器内部', () => {
    const w = mountGroup({ title: '分组 2', childIds: ['a', 'b'] })
    const strip = w.find('.group-drag-handle')
    const icon = strip.find('.group-title-icon')
    const title = strip.find('.group-title')
    expect(icon.exists() && title.exists()).toBe(true)
    // DOM 顺序：icon 在 title 之前
    expect(icon.element.compareDocumentPosition(title.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 图标不在分组容器内（容器 pointer-events:none，只作视觉承载）
    expect(w.find('.group-node-container .group-title-icon').exists()).toBe(false)
    w.unmount()
  })
})

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

  it('对比度校准锁（2026-10-12 复测）：常态 55%/10%，选中态 80%/16%/45% 外环', () => {
    const css = readFileSync(join(WEB, 'src', 'styles', 'neo-node.css'), 'utf8')
    const block = css.match(/\.group-node-container\s*\{[^}]*\}/)?.[0] ?? ''
    // 旧值 32%/7% 双主题都太淡（用户实测「释放后看不清」）——回退即红
    expect(block).toContain(') 55%, transparent')
    expect(block).toContain(') 10%, transparent')
    expect(block).not.toContain(') 32%, transparent')
    expect(block).not.toContain(') 7%, transparent')
    const active = css.match(/\.group-node-wrapper\.is-active \.group-node-container\s*\{[^}]*\}/)?.[0] ?? ''
    expect(active).toContain(') 80%, var(--neo-border-strong)')
    expect(active).toContain(') 16%, transparent')
    expect(active).toContain(') 45%, transparent')
  })

  it('标题外沿化：与图片/视频节点同位同字体（top:-32px · 13px/600 · --neo-node-title-color）', () => {
    const w = mountGroup({ title: 'g', childIds: ['a'] })
    // 结构层：标题条不再是容器的子元素（挂在 wrapper 下、与容器平级）
    const strip = w.find('.group-drag-handle')
    expect(strip.exists()).toBe(true)
    expect(strip.classes(), '标题条不应带容器类').not.toContain('group-node-container')
    expect(w.find('.group-node-container .group-drag-handle').exists(), '旧「卡内信息条」结构不得复活').toBe(false)
    w.unmount()
    // jsdom 无法算布局 —— 定位与字体锁在组件 SFC 源码层
    const fs = readFileSync(join(HERE, 'CanvasNodeGroup.vue'), 'utf8')
    const handleScope = fs.match(/(?:^|\n)\.group-drag-handle\s*\{[^}]*\}/)?.[0] ?? ''
    expect(handleScope, '标题条应绝对定位在卡片外沿上方（同 neo-node-external-title）').toContain('top: -32px')
    const titleScope = fs.match(/(?:^|\n)\.group-title\s*\{[^}]*\}/)?.[0] ?? ''
    expect(titleScope).toContain('font-size: 13px')
    expect(titleScope).toContain('font-weight: 600')
    expect(titleScope, '标题色应与图片/视频节点标题同 token').toContain('var(--neo-node-title-color)')
    expect(titleScope, 'muted 灰不得回潮').not.toContain('--neo-node-text-muted')
  })

  it('色卡令牌两主题成对：neowow-tokens 深浅块各有 8 个 --neo-group-*，且为复测校准档', () => {
    const css = readFileSync(join(WEB, 'src', 'styles', 'neowow-tokens.css'), 'utf8')
    const at = css.indexOf(":root[data-theme='light']")
    expect(at, '找不到浅色块').toBeGreaterThan(0)
    const count = (scope: string) => (scope.match(/--neo-group-[a-z]+:/g) ?? []).length
    expect(count(css.slice(0, at))).toBe(8)
    expect(count(css.slice(at))).toBe(8)
    // 校准值钉死：深色档提亮 / 浅色档加深（2026-10-12 复测，用户实测旧值太淡）
    const dark = css.match(/--neo-group-neutral:\s*(#[0-9a-fA-F]+)/)?.[1]
    const light = css.slice(at).match(/--neo-group-neutral:\s*(#[0-9a-fA-F]+)/)?.[1]
    expect(dark).toBe('#6b7080')
    expect(light).toBe('#b9bfd0')
  })
})
