import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { VueFlow } from '@vue-flow/core'
import MobileNodeHandles from './MobileNodeHandles.vue'
import MobileNodeTile from './MobileNodeTile.vue'
import { CANVAS_MULTI_SELECT_ACTIVE_KEY } from '@/composables/canvasNodeActions'
import {
  useMobileNodeConnect,
  __resetMobileConnectForTest,
} from '@/composables/useMobileNodeConnect'

// 仅覆盖 useNodeId：让组件（含 VueFlow 节点内挂载）拿到稳定节点 id 'n1'，
// 便于断言「点 + ⇒ enter('n1')」。VueFlow 其余导出保持真实。
vi.mock('@vue-flow/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vue-flow/core')>()
  return { ...actual, useNodeId: () => 'n1' }
})

/**
 * 移动端连线手柄守卫（修复 P3 锚点退化）。
 * ⭐ 变异自检：以下断言刻意"精确"——
 *   - 数量恰为 2（删掉任一 Handle ⇒ 断言 RED）；
 *   - id 必为 target/source（改错 id ⇒ 存量边 sourceHandle/targetHandle 失配 ⇒ RED）；
 *   - position 必为 left/right（改成 top/bottom ⇒ 连线从上下走，违背"A 右→B 左" ⇒ RED）。
 * 任一变异都会让测试变红，证明断言非恒真、非恒假。
 *
 * 手柄依赖 VueFlow 节点上下文（useNodeId 提供 nodeId）才渲染，故在真实 <VueFlow>
 * 节点内挂载；孤立挂载（无节点上下文）时手柄不渲染（见组件守卫）。
 */
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    ;(globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  if (!globalThis.DOMMatrixReadOnly) {
    ;(globalThis as any).DOMMatrixReadOnly = class {
      m22 = 1
      constructor(_t?: string) {}
    }
  }
  ;(Element.prototype as any).getBoundingClientRect = function () {
    return {
      x: 0, y: 0, width: 200, height: 160,
      top: 0, left: 0, right: 200, bottom: 160,
      toJSON() {},
    }
  }
})

async function mountAsFlowNode(
  nodeTypeComponent: any,
  nodeType: string,
  nodeData: any = {},
  extraProvide: Record<symbol, unknown> = {},
) {
  const nodes = ref<any[]>([{ id: 'n1', type: nodeType, position: { x: 0, y: 0 }, data: nodeData }])
  const edges = ref<any[]>([])
  const nodeTypes = { [nodeType]: nodeTypeComponent }
  const Harness = defineComponent({
    render() {
      return h(VueFlow as any, {
        nodes: nodes.value,
        edges: edges.value,
        nodeTypes,
        'apply-default': false,
        nodesConnectable: true,
      })
    },
  })
  const w = mount(Harness, { attachTo: document.body, global: { provide: extraProvide } })
  await nextTick()
  await nextTick()
  await flushPromises()
  return w
}

describe('MobileNodeHandles（真实 VueFlow 节点内）', () => {
  it('渲染恰好两个连线锚点（target=左 / source=右），id 与 PC 一致', async () => {
    const w = await mountAsFlowNode(MobileNodeHandles, 'handles')
    const handles = w.findAll('.vue-flow__handle')
    expect(handles).toHaveLength(2)

    const target = w.find('.vue-flow__handle-left')
    const source = w.find('.vue-flow__handle-right')
    expect(target.exists()).toBe(true)
    expect(source.exists()).toBe(true)

    expect(target.attributes('data-handleid')).toBe('target')
    expect(source.attributes('data-handleid')).toBe('source')

    // 每个手柄都带命中区 + 圆形 + 号（与 PC NeoBaseNode 同结构，可被触控连线）
    for (const h of [target, source]) {
      expect(h.find('.handle-hitbox').exists()).toBe(true)
      expect(h.find('.handle-plus-inner').exists()).toBe(true)
    }
    w.unmount()
  })

  it('无多余 / 错误锚点：不存在 top/bottom 手柄，也不存在第三个手柄', async () => {
    const w = await mountAsFlowNode(MobileNodeHandles, 'handles')
    expect(w.find('.vue-flow__handle-top').exists()).toBe(false)
    expect(w.find('.vue-flow__handle-bottom').exists()).toBe(false)
    expect(w.findAll('.vue-flow__handle')).toHaveLength(2)
    w.unmount()
  })
})

describe('MobileNodeTile + 连线手柄集成', () => {
  it('移动端瓦片在节点内渲染出左右两个连线锚点', async () => {
    const w = await mountAsFlowNode(MobileNodeTile, 'image', { url: 'https://x/a.png' })
    expect(w.find('[data-testid="mobile-node-handles"]').exists()).toBe(true)
    expect(w.findAll('.vue-flow__handle')).toHaveLength(2)
    expect(w.find('.vue-flow__handle-left').attributes('data-handleid')).toBe('target')
    expect(w.find('.vue-flow__handle-right').attributes('data-handleid')).toBe('source')
    w.unmount()
  })

  it('手柄位于瓦片主体之外（结构上点手柄不会触发 onTileClick ⇒ 不会误开查看器）', async () => {
    const w = await mountAsFlowNode(MobileNodeTile, 'image', { url: 'https://x/a.png' })
    // 手柄不是 .mobile-node-tile 的后代 ⇒ 点手柄的点击不会冒泡到瓦片的打开逻辑
    expect(w.find('.mobile-node-tile .vue-flow__handle').exists()).toBe(false)
    w.unmount()
  })

  it('点瓦片主体仍正常 emit tap（手柄接入未破坏既有打开契约）', async () => {
    const w = await mountAsFlowNode(MobileNodeTile, 'image', { url: 'https://x/a.png' })
    const tile = w.findComponent(MobileNodeTile)
    await tile.get('.mobile-node-tile').trigger('click')
    expect(tile.emitted('tap')).toBeTruthy()
    w.unmount()
  })

  it('选择模式下手柄仍渲染（不影响批量选择，连线热区独立存在）', async () => {
    const w = await mountAsFlowNode(MobileNodeTile, 'image', { url: 'https://x/a.png' })
    w.unmount()
    // 重新挂载并注入选择模式（全局圆圈 + 轻点即选）
    const nodes = ref<any[]>([{ id: 'n1', type: 'image', position: { x: 0, y: 0 }, data: { url: 'https://x/a.png' } }])
    const edges = ref<any[]>([])
    const nodeTypes = { image: MobileNodeTile }
    const Harness = defineComponent({
      render() {
        return h(VueFlow as any, {
          nodes: nodes.value,
          edges: edges.value,
          nodeTypes,
          'apply-default': false,
          nodesConnectable: true,
        })
      },
    })
    const w2 = mount(Harness, {
      attachTo: document.body,
      global: {
        provide: { [CANVAS_MULTI_SELECT_ACTIVE_KEY as symbol]: { value: true } },
      },
    })
    await nextTick()
    await nextTick()
    await flushPromises()
    expect(w2.findAll('.vue-flow__handle')).toHaveLength(2)
    w2.unmount()
  })
})

/** ⭐ 变异自检：断言精确——删掉 handle-tap-catch / 改 enter 行为 / 改成不 .stop，
 *  都会让以下用例变红，证明断言非恒真、非恒假。
 *  连线模式为模块单例（useMobileNodeConnect），手柄组件直接 import，无需跨 VueFlow
 *  子树 inject；此处作为 VueFlow 节点挂载（Handle 依赖节点上下文）验证点击接线。 */
describe('MobileNodeHandles · 点 + 进入连线模式（R-C1 / R-C4）', () => {
  beforeEach(() => __resetMobileConnectForTest())

  async function mountHandlesInFlow() {
    const nodes = ref<any[]>([{ id: 'n1', type: 'handles', position: { x: 0, y: 0 }, data: {} }])
    const edges = ref<any[]>([])
    const nodeTypes = { handles: MobileNodeHandles }
    const Wrapper = defineComponent({
      render() {
        return h(VueFlow as any, {
          nodes: nodes.value,
          edges: edges.value,
          nodeTypes,
          'apply-default': false,
          nodesConnectable: true,
        })
      },
    })
    const w = mount(Wrapper, { attachTo: document.body })
    await nextTick()
    await nextTick()
    await flushPromises()
    return w
  }

  it('源 + 覆盖层存在且点击 ⇒ 单例 enter(nodeId)', async () => {
    const w = await mountHandlesInFlow()
    const tapCatch = w.find('.handle-tap-catch')
    expect(tapCatch.exists()).toBe(true)
    expect(useMobileNodeConnect().pendingSource.value).toBeNull()
    await tapCatch.trigger('click')
    expect(useMobileNodeConnect().pendingSource.value).toBe('n1')
    w.unmount()
  })

  it('再点同一源 + ⇒ 单例 cancel（R-C4 三选一之一）', async () => {
    const w = await mountHandlesInFlow()
    const tapCatch = w.find('.handle-tap-catch')
    await tapCatch.trigger('click') // 进入
    expect(useMobileNodeConnect().pendingSource.value).toBe('n1')
    await tapCatch.trigger('click') // 再点同一源 ⇒ 取消
    expect(useMobileNodeConnect().pendingSource.value).toBeNull()
    w.unmount()
  })

  it('未注册落库回调时点击 + 不抛错（降级安全）', async () => {
    const w = await mountHandlesInFlow()
    const tapCatch = w.find('.handle-tap-catch')
    expect(tapCatch.exists()).toBe(true)
    await tapCatch.trigger('click')
    expect(useMobileNodeConnect().pendingSource.value).toBe('n1')
    w.unmount()
  })
})
