/**
 * 分组节点组件的行为锁（2026-10-21 分组回归原生节点形态）。
 *
 * jsdom 无布局引擎 ⇒ 外形断言落在 DOM 结构 + 内联样式字符串 + 源码扫描
 * （与仓库既有 visual 测试同手法）。本文件锁住四条：
 *  1. 色卡经单一局部变量 `--group-accent` 注入，消费 `--lnk-group-*` 真源；
 *  2. 标题外沿条（top:-32px）+ 2×2 网格图标 + 子节点计数；
 *  3. **整框可拖**（不设 dragHandle）—— 设了就退回「只能抓标题条」的老形态；
 *  4. 双击标题条改名走 CANVAS_NODE_RENAME_KEY；且组件零 `--neo-*` 消费。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { CANVAS_NODE_RENAME_KEY } from '@/composables/canvasNodeActions'
import CanvasNodeGroup from './CanvasNodeGroup.vue'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, 'CanvasNodeGroup.vue'), 'utf8')

/**
 * 源码扫描口径：**只扫代码，不扫注释**（同 neoUsageRatchet）。
 * 不剥注释的话，本文件里解释「为什么不要设 dragHandle / 为什么 #494 是工程妥协」
 * 的说明文字会把自己判红 —— 判据必须钉住行为，而不是钉住我们自己写的散文。
 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
}
const CODE = stripComments(SRC)

vi.mock('@vue-flow/core', () => ({ useNode: () => ({ id: 'group-1' }) }))

function mountGroup(data: Record<string, unknown>, selected = false, renameNode = vi.fn()) {
  const wrapper = mount(CanvasNodeGroup, {
    props: { data, selected },
    global: { provide: { [CANVAS_NODE_RENAME_KEY as symbol]: renameNode } },
  })
  return { wrapper, renameNode }
}

describe('分组节点：色卡注入', () => {
  it("colorKey='moss' → 根节点 --group-accent: var(--lnk-group-moss)", () => {
    const { wrapper } = mountGroup({ title: '第一组', childIds: ['a', 'b'], colorKey: 'moss' })
    const style = wrapper.attributes('style') ?? ''
    expect(style).toContain('--group-accent')
    expect(style).toContain('var(--lnk-group-moss)')
  })

  it('colorKey 缺省 / 非法 ⇒ 落 neutral（不得把裸 key 拼进 var()）', () => {
    for (const colorKey of [undefined, '不存在的色', '', 42]) {
      const { wrapper } = mountGroup({ title: 'x', colorKey })
      const style = wrapper.attributes('style') ?? ''
      expect(style).toContain('var(--lnk-group-neutral)')
      expect(style).not.toContain('var(--lnk-group-不存在的色)')
    }
  })

  it('容器边框/底色从 --group-accent 派生（组件不写死颜色）', () => {
    // 断言真实 DOM，而不是源码里出现过这个类名 —— 剥注释后源码里只剩模板的 class
    const { wrapper } = mountGroup({ title: '第一组' })
    expect(wrapper.find('.group-node-container').exists()).toBe(true)
    // 颜色只在 neo-node.css 里 color-mix，组件内不得出现字面 hex
    expect(CODE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('分组节点：标题外沿条', () => {
  it('标题条外沿化（top:-32px）+ 2×2 网格图标 + 子节点计数', () => {
    const { wrapper } = mountGroup({ title: '第一组', childIds: ['a', 'b'] })
    const bar = wrapper.find('.group-drag-handle')
    expect(bar.exists()).toBe(true)
    expect(wrapper.find('.group-title-icon svg').exists()).toBe(true)
    expect(wrapper.find('.group-title').text()).toBe('第一组')
    expect(wrapper.find('.group-meta').text()).toBe('2 个节点')
    expect(CODE).toMatch(/\.group-drag-handle\s*\{[^}]*top:\s*-32px/s)
  })

  it('无标题 / 无子节点 ⇒ 回落文案，不渲染空白条', () => {
    const { wrapper } = mountGroup({})
    expect(wrapper.find('.group-title').text()).toBe('未命名分组')
    expect(wrapper.find('.group-meta').text()).toBe('0 个节点')
  })
})

describe('分组节点：整框可拖（#494 之前被抱怨的形态不许回来）', () => {
  it('wrapper 铺满节点盒 + grab 光标', () => {
    const { wrapper } = mountGroup({ title: 'x' })
    const root = wrapper.find('.group-node-wrapper')
    expect(root.exists()).toBe(true)
    expect(CODE).toMatch(/\.group-node-wrapper\s*\{[^}]*cursor:\s*grab/s)
    expect(CODE).toMatch(/\.group-node-wrapper\s*\{[^}]*width:\s*100%/s)
  })

  it('⛔ 组件不得把拖拽面限定到标题条（设了就只剩 26px 能拖）', () => {
    // 判据钉在**渲染出来的根元素属性**上，不在源码字面量上：
    // 变异实测 —— 在模板上加 `drag-handle=".group-drag-handle"` 时，源码正则
    // 断言（查 `dragHandle` / `:drag-handle` 字面量）照样绿，是假判据。
    const { wrapper } = mountGroup({ title: '第一组' })
    const root = wrapper.find('.group-node-wrapper')
    expect(root.attributes('drag-handle')).toBeUndefined()
    expect(root.attributes('dragHandle')).toBeUndefined()
    // 不做「源码里不许出现 drag-handle 字样」这种粗判据：CSS 的
    // `.group-drag-handle:hover` 也会被命中，纯噪音。真正的开关在节点对象上
    // （vue-flow 从 node.dragHandle 读），由 useCanvasGrouping.native.test.ts
    // 的「group 节点不得带 dragHandle」把守。
  })

  it('容器本体不吃指针（.group-node-container 在 neo-node.css 里 pointer-events:none）', () => {
    const neo = readFileSync(
      join(here, '..', '..', 'styles', 'neo-node.css'),
      'utf8',
    )
    const block = neo.match(/\.group-node-container\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(block, '.group-node-container 规则块没找到').toContain('pointer-events: none')
  })

  it('⛔ 不提供连线 Handles（连到分组框没有语义）', () => {
    expect(CODE).not.toContain('<Handle')
    expect(CODE).not.toContain('neo-flow-handle')
  })
})

describe('分组节点：改名', () => {
  it('双击标题条 → 输入框 → 回车 ⇒ 走 CANVAS_NODE_RENAME_KEY(nodeId, title)', async () => {
    const { wrapper, renameNode } = mountGroup({ title: '旧名字', childIds: ['a', 'b'] })
    await wrapper.find('.group-drag-handle').trigger('dblclick')
    const input = wrapper.find('.group-rename-input')
    expect(input.exists()).toBe(true)
    await input.setValue('新名字')
    await input.trigger('keydown.enter')
    expect(renameNode).toHaveBeenCalledWith('group-1', '新名字')
    expect(wrapper.find('.group-rename-input').exists()).toBe(false)
  })

  it('空标题不提交（避免把分组名写成空）', async () => {
    const { wrapper, renameNode } = mountGroup({ title: '旧名字' })
    await wrapper.find('.group-drag-handle').trigger('dblclick')
    await wrapper.find('.group-rename-input').setValue('   ')
    await wrapper.find('.group-rename-input').trigger('keydown.enter')
    expect(renameNode).not.toHaveBeenCalled()
  })

  it('Esc 取消改名', async () => {
    const { wrapper, renameNode } = mountGroup({ title: '旧名字' })
    await wrapper.find('.group-drag-handle').trigger('dblclick')
    await wrapper.find('.group-rename-input').trigger('keydown.esc')
    expect(renameNode).not.toHaveBeenCalled()
    expect(wrapper.find('.group-title').text()).toBe('旧名字')
  })
})

describe('令牌纪律：组件零 --neo-* 消费（棘轮只减不增）', () => {
  it('⛔ CanvasNodeGroup.vue 内不得出现 --neo-（真源是 --lnk-group-*）', () => {
    expect(CODE.match(/--neo-/g) ?? []).toEqual([])
  })
})

describe('根因回归：手搓视口变换层不得被引回来', () => {
  /**
   * ②「塞进信封」的真因：`.canvas-group-layer` 同时带 `transform`（手搓 viewport
   * 变换）与 `overflow:hidden`。CSS 规定 `overflow` 在变换元素上按**元素本地坐标
   * 空间**裁剪 ⇒ 裁到的不是可见屏幕区，而是层本地流空间的 pane 矩形；映射到屏幕
   * 后裁剪线落在 y≈1012（实测），框底约 240px 连同整条底边框被吞，拖动时逐帧恶化。
   *
   * 分组回归原生节点后这层整体消失（裁剪交给 `.vue-flow__viewport` 的
   * `overflow:clip`，它在**未变换**容器上 = 屏幕空间裁剪）。本断言确保它不会被
   * 重新引回 —— 它一回来，这个 bug 就原样复现。
   */
  it('⛔ apps/web/src 下不得再出现 canvas-group-layer（transform + overflow 的组合）', () => {
    const hits: string[] = []
    const SELF = 'CanvasNodeGroup.test.ts' // 守卫自身含该字面量，排除（与 neoUsageRatchet 同法）
    ;(function walk(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(vue|ts|css)$/.test(e.name) && e.name !== SELF) {
          if (readFileSync(p, 'utf8').includes('canvas-group-layer')) hits.push(p)
        }
      }
    })(join(here, '..', '..'))
    expect(hits, `canvas-group-layer 被引回了：${hits.join(', ')}`).toEqual([])
  })

  it('⛔ CanvasPage 不得再挂载 CanvasGroupOverlay', () => {
    const page = readFileSync(join(here, '..', '..', 'pages', 'CanvasPage.vue'), 'utf8')
    expect(stripComments(page)).not.toContain('CanvasGroupOverlay')
  })

  it('⛔ 分组只经 nodeTypes.group 注册（不得再有第二条渲染路径）', () => {
    const page = stripComments(
      readFileSync(join(here, '..', '..', 'pages', 'CanvasPage.vue'), 'utf8'),
    )
    expect(page).toContain('group: CanvasNodeGroup')
    // 每份 @vue-flow/core 的节点渲染都只在这一处注册
    expect(page.match(/group:\s*CanvasNodeGroup/g) ?? []).toHaveLength(1)
  })
})
