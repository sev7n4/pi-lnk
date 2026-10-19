import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CanvasGroup } from '@lnkpi/shared'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..', '..')

vi.mock('@vue-flow/core', () => ({
  // 分组是 overlay（不是节点）⇒ 不再需要 Handle/useNode，只需 viewport 变换。
  useVueFlow: () => ({ viewport: { value: { x: 0, y: 0, zoom: 1 } } }),
}))

import CanvasGroupOverlay from './CanvasGroupOverlay.vue'

function group(over: Partial<CanvasGroup> = {}): CanvasGroup {
  return {
    id: 'group-1',
    title: '分组 1',
    childIds: ['a', 'b'],
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    ...over,
  }
}

function mountOverlay(groups: CanvasGroup[], selectedGroupId: string | null = null) {
  return mount(CanvasGroupOverlay, { props: { groups, selectedGroupId } })
}

/**
 * 分组视觉回归锁（2026-10-12 P3，2026-10-20 移植到侧车 overlay）。
 *
 * 用户口径：① 分组内部不该内嵌实体小卡（徽标 + 名称 + 计数 + 拖拽说明），
 * 信息应收成贴上沿的无底信息条；② 默认色不该是品牌紫；③ 分组色可自定义色卡，
 * 默认与画布仅数个百分点明度差。
 *
 * jsdom 无布局引擎 ⇒ 外形断言落在 DOM 结构、`--neo-group-accent` 注入值、
 * 以及全局 css 规则层（紫色 rgba 清零 + 容器规则消费 accent 令牌）。
 */
describe('CanvasGroupOverlay：标题前分组图标（2026-10-13）', () => {
  it('有效性前置：标题条渲染分组图标（svg）且无文字徽标', () => {
    const w = mountOverlay([group()])
    const icon = w.find('.group-title-icon')
    expect(icon.exists(), '分组图标必须渲染').toBe(true)
    expect(icon.find('svg').exists(), '图标应为 svg').toBe(true)
    expect(icon.text(), '图标不得携带文字（避免复活旧「分组」徽标）').toBe('')
    w.unmount()
  })

  it('图标颜色跟随分组背景色：CSS 消费 --neo-group-accent，svg 用 currentColor 继承', () => {
    const fs = readFileSync(join(HERE, 'CanvasGroupOverlay.vue'), 'utf8')
    const iconScope = fs.match(/(?:^|\n)\.group-title-icon\s*\{[^}]*\}/)?.[0] ?? ''
    expect(iconScope, '找不到分组图标规则块').toBeTruthy()
    expect(iconScope, '图标色应跟随分组色（与色卡当前色一致）').toContain('var(--neo-group-accent)')
    const svgTag = fs.match(/<svg[^>]*stroke="currentColor"[^>]*>/)?.[0] ?? ''
    expect(svgTag, '图标 svg 应以 currentColor 描边').toContain('stroke="currentColor"')
    const w = mountOverlay([group({ colorKey: 'moss' })])
    const style = w.find('.group-node-wrapper').attributes('style') ?? ''
    expect(style).toContain('var(--neo-group-moss)')
    w.unmount()
  })

  it('图标位于标题之前（速识位），不侵占容器内部', () => {
    const w = mountOverlay([group()])
    const strip = w.find('.group-drag-handle')
    const icon = strip.find('.group-title-icon')
    const title = strip.find('.group-title')
    expect(icon.exists() && title.exists()).toBe(true)
    expect(
      icon.element.compareDocumentPosition(title.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // 容器 pointer-events:none 只作视觉承载，图标不得在里面
    expect(w.find('.group-node-container .group-title-icon').exists()).toBe(false)
    w.unmount()
  })
})

describe('CanvasGroupOverlay：信息条外沿化（拆内嵌小卡）', () => {
  it('有效性前置：信息条渲染名称与节点数', () => {
    const w = mountOverlay([group({ title: '分组 0', childIds: ['a', 'b'] })])
    const strip = w.find('.group-drag-handle')
    expect(strip.exists(), '信息条必须渲染').toBe(true)
    expect(strip.text()).toContain('分组 0')
    expect(strip.text()).toContain('2 个节点')
    w.unmount()
  })

  it('内嵌卡要素不得复活：无「分组」徽标、无「拖此栏移动整组」说明', () => {
    const w = mountOverlay([group({ title: '我的分组', childIds: ['a'] })])
    const badges = w.findAll('span').filter((s) => s.text() === '分组')
    expect(badges, '「分组」徽标不得复活').toEqual([])
    expect(w.text()).not.toContain('拖此栏移动整组')
    w.unmount()
  })

  it('overlay 层在节点之下且框体不吞点击（只有标题条可交互）', () => {
    const w = mountOverlay([group()])
    // 框体 pointer-events:none ⇒ 点框内空白不会抢走子节点点击
    const container = w.find('.group-node-container')
    expect(container.exists()).toBe(true)
    const fs = readFileSync(join(HERE, 'CanvasGroupOverlay.vue'), 'utf8')
    // 容器规则在全局 css 里声明 pointer-events:none（此处锁组件层不覆写它）
    expect(fs).not.toMatch(/\.group-node-container\s*\{[^}]*pointer-events:\s*auto/)
    // 防回退：交互事件（dblclick/pointer*）不得挂在收不到事件的框体上
    expect(fs).not.toMatch(/<div class="group-node-container"[^>]*@/)
    // 标题条显式开指针事件（拖动入口）
    const handleScope = fs.match(/(?:^|\n)\.group-drag-handle\s*\{[^}]*\}/)?.[0] ?? ''
    expect(handleScope).toContain('pointer-events: auto')
    w.unmount()
  })

  it('信息条无卡感：结构层不再有独立边框/底色类', () => {
    const css = readFileSync(join(WEB, 'src', 'styles', 'neo-node.css'), 'utf8')
    expect(css).not.toContain('rgba(24, 24, 27, 0.72)')
    expect(css).not.toContain('backdrop-filter: blur(8px)')
  })

  it('改名流保留：双击出输入框，回车提交 rename 事件', async () => {
    const w = mountOverlay([group({ title: '分组 0', childIds: ['a'] })])
    // ⚠️ 必须打在标题条上：框体是 pointer-events:none，真机收不到 dblclick。
    await w.find('.group-drag-handle').trigger('dblclick')
    const input = w.find('.group-rename-input')
    expect(input.exists(), '双击后应出现改名输入框').toBe(true)
    await input.setValue('新名字')
    await input.trigger('keydown.enter.stop')
    expect(w.emitted('rename')).toBeTruthy()
    expect(w.emitted('rename')![0]).toEqual(['group-1', '新名字'])
    w.unmount()
  })
})

describe('CanvasGroupOverlay：色卡注入与默认去紫', () => {
  it('colorKey=moss → 根节点注入 --neo-group-accent: var(--neo-group-moss)', () => {
    const w = mountOverlay([group({ colorKey: 'moss' })])
    const style = w.find('.group-node-wrapper').attributes('style') ?? ''
    expect(style).toContain('--neo-group-accent')
    expect(style).toContain('var(--neo-group-moss)')
    w.unmount()
  })

  it('非法 colorKey 与缺省 → 落 neutral（旧分组天然兼容）', () => {
    for (const g of [group({ colorKey: 'rainbow' }), group()]) {
      const w = mountOverlay([g])
      const style = w.find('.group-node-wrapper').attributes('style') ?? ''
      expect(style).toContain('var(--neo-group-neutral)')
      w.unmount()
    }
  })

  it('CSS 规则层：分组规则块品牌紫清零，容器背景/虚线边消费 --neo-group-accent', () => {
    const css = readFileSync(join(WEB, 'src', 'styles', 'neo-node.css'), 'utf8')
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
    const w = mountOverlay([group()])
    const strip = w.find('.group-drag-handle')
    expect(strip.exists()).toBe(true)
    expect(strip.classes(), '标题条不应带容器类').not.toContain('group-node-container')
    expect(w.find('.group-node-container .group-drag-handle').exists(), '旧「卡内信息条」结构不得复活').toBe(false)
    w.unmount()
    const fs = readFileSync(join(HERE, 'CanvasGroupOverlay.vue'), 'utf8')
    const handleScope = fs.match(/(?:^|\n)\.group-drag-handle\s*\{[^}]*\}/)?.[0] ?? ''
    expect(handleScope, '标题条应绝对定位在卡片外沿上方（同 neo-node-external-title）').toContain('top: -32px')
    const titleScope = fs.match(/(?:^|\n)\.group-title\s*\{[^}]*\}/)?.[0] ?? ''
    expect(titleScope).toContain('font-size: 13px')
    expect(titleScope).toContain('font-weight: 600')
    expect(titleScope, '标题色应与图片/视频节点标题同 token').toContain('var(--neo-node-title-color)')
  })

  it('色卡令牌两主题成对：design-tokens 深浅块各有 8 个 --lnk-group-*，且为复测校准档', () => {
    // 2026-10-20 PR3：色值真源迁入 design-tokens.css 的 --lnk-group-*（新组件零 --neo-*），
    // neowow-tokens 的 --neo-group-* 降级为别名。本测试盯**值**不盯文件位置：
    // 校准档从新真源读，并配对断言旧名确为别名（防止有人把两份真源又拆开）。
    const css = readFileSync(join(WEB, 'src', 'styles', 'design-tokens.css'), 'utf8')
    const at = css.indexOf(":root[data-theme='light']")
    expect(at, '找不到浅色块').toBeGreaterThan(0)
    const count = (scope: string) => (scope.match(/--lnk-group-[a-z]+:/g) ?? []).length
    expect(count(css.slice(0, at))).toBe(8)
    expect(count(css.slice(at))).toBe(8)
    // 校准值钉死：深色档提亮 / 浅色档加深（2026-10-12 复测，用户实测旧值太淡）
    // 真源已迁到 --lnk-group-*（旧名 --neo-group-* 是别名），故从 --lnk 读值。
    const dark = css.match(/--lnk-group-neutral:\s*(#[0-9a-fA-F]+)/)?.[1]
    const light = css.slice(at).match(/--lnk-group-neutral:\s*(#[0-9a-fA-F]+)/)?.[1]
    expect(dark).toBe('#6b7080')
    expect(light).toBe('#b9bfd0')

    // 旧名必须是别名而非第二份真源
    const neo = readFileSync(join(WEB, 'src', 'styles', 'neowow-tokens.css'), 'utf8')
    expect(neo).toMatch(/--neo-group-neutral:\s*var\(--lnk-group-neutral\)/)
    expect(neo).not.toMatch(/--neo-group-[a-z]+:\s*#[0-9a-fA-F]+/)
  })
})
