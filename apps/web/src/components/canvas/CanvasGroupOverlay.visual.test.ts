import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CanvasGroup } from '@lnkpi/shared'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..', '..')

// 可变的 vue-flow store 影子：chip 视口钳制测试需要在用例内改 viewport/pane 尺寸。
const vueFlow = vi.hoisted(() => ({
  state: {
    viewport: { x: 0, y: 0, zoom: 1 },
    dimensions: { width: 0, height: 0 },
  },
}))

vi.mock('@vue-flow/core', () => ({
  // 分组是 overlay（不是节点）⇒ 不再需要 Handle/useNode，只需 viewport 变换。
  // dimensions=pane 尺寸（jsdom 初始 0 ⇒ chip 钳制退回 CSS 默认位，见 chipStyle 守卫）。
  useVueFlow: () => ({
    viewport: {
      get value() {
        return vueFlow.state.viewport
      },
    },
    dimensions: {
      get value() {
        return vueFlow.state.dimensions
      },
    },
  }),
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
  beforeEach(() => {
    vueFlow.state = { viewport: { x: 0, y: 0, zoom: 1 }, dimensions: { width: 0, height: 0 } }
  })

  it('chip 视口钳制：巨型分组（框边全在视口外）⇒ 标题条被钳回屏内且可点', () => {
    // 生产实况（2026-10-20）：分组 1921×757 @zoom0.554，框顶/左在视口外
    vueFlow.state = {
      viewport: { x: 109, y: 72, zoom: 0.554 },
      dimensions: { width: 1080, height: 428 },
    }
    const w = mountOverlay([group({ position: { x: -208, y: -142 }, size: { width: 1921, height: 757 } })])
    const style = w.find('.group-drag-handle').attributes('style') ?? ''
    // world 偏移换算回 screen 后必须落在视口内（margin=8）
    const top = Number(style.match(/top:\s*([-\d.]+)px/)?.[1] ?? NaN)
    const left = Number(style.match(/left:\s*([-\d.]+)px/)?.[1] ?? NaN)
    expect(Number.isFinite(top), '应有内联 top 覆写').toBe(true)
    const screenTop = 72 + (-142 + top) * 0.554
    const screenLeft = 109 + (-208 + left) * 0.554
    expect(screenTop).toBeGreaterThanOrEqual(8 - 1e-6)
    expect(screenLeft).toBeGreaterThanOrEqual(8 - 1e-6)
    expect(screenTop).toBeLessThan(428)
    w.unmount()
  })

  it('pane 尺寸未知（jsdom 初始 0）⇒ 不覆写 CSS 默认位（无内联 top/left）', () => {
    const w = mountOverlay([group()])
    const style = w.find('.group-drag-handle').attributes('style') ?? ''
    expect(style).not.toMatch(/top:/)
    expect(style).not.toMatch(/left:/)
    w.unmount()
  })

  it('有效性前置：标题条渲染分组图标（svg）且无文字徽标', () => {
    const w = mountOverlay([group()])
    const icon = w.find('.group-title-icon')
    expect(icon.exists(), '分组图标必须渲染').toBe(true)
    expect(icon.find('svg').exists(), '图标应为 svg').toBe(true)
    expect(icon.text(), '图标不得携带文字（避免复活旧「分组」徽标）').toBe('')
    w.unmount()
  })

  it('图标颜色跟随分组背景色：CSS 消费分组色别名，svg 用 currentColor 继承', () => {
    const fs = readFileSync(join(HERE, 'CanvasGroupOverlay.vue'), 'utf8')
    const iconScope = fs.match(/(?:^|\n)\.group-title-icon\s*\{[^}]*\}/)?.[0] ?? ''
    expect(iconScope, '找不到分组图标规则块').toBeTruthy()
    // 图标消费 --group-accent；该别名在 .group-node-wrapper 上解析为按 colorKey 注入的
    // --neo-group-accent（见下一断言）——只允许一处真源消费，避免重复计数旧令牌。
    expect(iconScope, '图标色应跟随分组色（与色卡当前色一致）').toContain('var(--group-accent)')
    const aliasScope = fs.match(/--group-accent:\s*var\(--neo-group-accent,\s*var\(--neo-group-neutral\)\)/)?.[0] ?? ''
    expect(aliasScope, '--group-accent 必须解析到按 colorKey 注入的 --neo-group-accent').toBeTruthy()
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

  it('容器必须铺满 wrapper（回归钉子：侧车化丢 h-full/w-full 后塌成 160px 横带，节点全挂框外）', () => {
    const fs = readFileSync(join(HERE, 'CanvasGroupOverlay.vue'), 'utf8')
    const scope = fs.match(/(?:^|\n)\.group-node-container\s*\{[^}]*\}/)?.[0] ?? ''
    expect(scope, '容器应绝对定位铺满 wrapper（inset:0）').toContain('position: absolute')
    expect(scope).toContain('inset: 0')
    // 模板层不得再用旧节点形态的 Tailwind 撑满类（铺满职责已收归 scoped，避免双源漂移）
    expect(fs).not.toMatch(/class="group-node-container[^"]*h-full/)
    expect(fs).not.toMatch(/class="group-node-container[^"]*w-full/)
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

  it('draggable=false（移动端）时不启动拖动、不发 move', async () => {
    const w = mount(CanvasGroupOverlay, { props: { groups: [group()], selectedGroupId: null, draggable: false } })
    const handle = w.find('.group-drag-handle')
    expect(handle.classes()).not.toContain('is-draggable')
    // ⚠️ jsdom 的 MouseEvent 属性只读 ⇒ 不用 test-utils 的 trigger 传参，
    // 直接派发带坐标的原生事件（button=0 才会进入拖动分支）。
    const el = handle.element as HTMLElement
    const down = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 })
    el.dispatchEvent(down)
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 40 }))
    await w.vm.$nextTick()
    expect(w.emitted('move'), '禁拖时不得产生 move（否则会与长按手势打架）').toBeFalsy()
    w.unmount()

    const on = mount(CanvasGroupOverlay, { props: { groups: [group()], selectedGroupId: null, draggable: true } })
    expect(on.find('.group-drag-handle').classes()).toContain('is-draggable')
    const onEl = on.find('.group-drag-handle').element as HTMLElement
    onEl.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }))
    onEl.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 40 }))
    await on.vm.$nextTick()
    expect(on.emitted('move')).toBeTruthy()
    on.unmount()
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

  it('对比度校准锁（2026-10-20 上调可见度）：常态 70%/12% + 22% 外环，选中态 85%/18%/55%', () => {
    const css = readFileSync(join(WEB, 'src', 'styles', 'neo-node.css'), 'utf8')
    const block = css.match(/\.group-node-container\s*\{[^}]*\}/)?.[0] ?? ''
    expect(block).toContain(') 70%, transparent')
    expect(block).toContain(') 12%, transparent')
    expect(block).toContain(') 22%, transparent')
    expect(block).not.toContain(') 32%, transparent')
    expect(block).not.toContain(') 7%, transparent')
    const active = css.match(/\.group-node-wrapper\.is-active \.group-node-container\s*\{[^}]*\}/)?.[0] ?? ''
    expect(active).toContain(') 85%, var(--neo-border-strong)')
    expect(active).toContain(') 18%, transparent')
    expect(active).toContain(') 55%, transparent')
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

  it('标题条带 × 解组按钮：点击单向 emit ungroup(groupId)，不依赖浮层工具条', async () => {
    const w = mount(CanvasGroupOverlay, {
      props: {
        groups: [group()],
        selectedGroupId: null,
        nodes: [
          { id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} },
          { id: 'b', type: 'text', position: { x: 400, y: 0 }, data: {} },
        ] as never,
      },
    })
    const btn = w.find('.group-ungroup-btn')
    expect(btn.exists(), '分组框必须自带解组按钮').toBe(true)
    await btn.trigger('click')
    expect(w.emitted('ungroup')).toBeTruthy()
    expect(w.emitted('ungroup')![0]).toEqual(['group-1'])
    w.unmount()
  })

  it('点框的四条边即可选中分组（框体内部仍不吃子节点点击）', async () => {
    const w = mount(CanvasGroupOverlay, {
      props: { groups: [group()], selectedGroupId: null },
    })
    // 四条边各一个热区 ⇒ 分组框很大时也能轻松点中，不必去够左上角那条窄标题
    const edges = w.findAll('.group-edge-hit')
    expect(edges).toHaveLength(4)
    for (const e of edges) {
      expect(e.classes().join(' ')).toMatch(/group-edge-hit--(top|right|bottom|left)/)
    }
    await edges[0].trigger('pointerdown')
    expect(w.emitted('select')).toBeTruthy()
    expect(w.emitted('select')![0]).toEqual(['group-1'])
    // 框体本身仍必须是 pointer-events:none（否则会吃掉子节点点击）
    const fs = readFileSync(join(HERE, 'CanvasGroupOverlay.vue'), 'utf8')
    expect(fs).not.toMatch(/<div class="group-node-container"[^>]*@/)
    w.unmount()
  })

  it('外框始终按实时子节点包围盒渲染（落库坐标陈旧也不错位）', () => {
    // 子节点在 (0,0)/(400,0)，但 groups 内存的 position/size 是错误旧值（节点已被拖动过）。
    const stale: CanvasGroup = {
      ...group(),
      position: { x: -999, y: -999 },
      size: { width: 10, height: 10 },
    }
    const w = mount(CanvasGroupOverlay, {
      props: {
        groups: [stale],
        selectedGroupId: null,
        nodes: [
          { id: 'a', type: 'image', position: { x: 0, y: 0 }, data: {} },
          { id: 'b', type: 'text', position: { x: 400, y: 0 }, data: {} },
        ] as never,
      },
    })
    const wrapper = w.find('.group-node-wrapper')
    // image 280×280 + text 280×160，padding 80 ⇒ x=-80, y=-80, w=840, h=440
    expect(wrapper.attributes('style')).toContain('translate(-80px, -80px)')
    expect(wrapper.attributes('style')).toContain('width: 840px')
    expect(wrapper.attributes('style')).toContain('height: 440px')
    w.unmount()
  })
})
