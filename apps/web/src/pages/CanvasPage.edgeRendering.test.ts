/**
 * 行为级回归：VueFlow 批量加载已有边时必须真的渲染出 `<path class="vue-flow__edge-path">`。
 *
 * 背景（2026-11-06）：SP-D 的 `:is-valid-connection="isValidConnection"` 被 VueFlow
 * 1.48 复用于 `setEdges()` → `createGraphEdges()` 的逐边校验；旧判据「本地已存在同向对
 * ⇒ false」会把每条已落库的边判成 EDGE_INVALID 全量丢弃，PC/移动端共用同一画布 ⇒
 * 双端零连线。此前 8+ 条 edge 测试全是静态文本断言（CSS 文本断言），全绿却不能证明
 * 屏幕上有线。本测试用真实 VueFlow 挂载，是「连线可见」这条契约的唯一行为级守卫。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import { VueFlow } from '@vue-flow/core'
import { isValidCanvasConnection } from '@/utils/canvasEdgeValidation'

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
      x: 0, y: 0, width: 800, height: 600,
      top: 0, left: 0, right: 800, bottom: 600,
      toJSON() {},
    }
  }
})

const NODES = [
  { id: 'a', type: 'default', position: { x: 0, y: 0 }, data: {} },
  { id: 'b', type: 'default', position: { x: 300, y: 0 }, data: {} },
  { id: 'c', type: 'default', position: { x: 600, y: 0 }, data: {} },
]
const EDGES = [
  { id: 'e1', source: 'a', target: 'b' },
  { id: 'e2', source: 'b', target: 'c' },
]

/** 复刻 CanvasPage 的绑定（:edges + :is-valid-connection），不复制判据本身 */
const Harness = defineComponent({
  props: { withValidation: { type: Boolean, default: true } },
  setup(props) {
    const nodes = ref<any[]>([])
    const edges = ref<any[]>([])
    const errors: string[] = []
    const isValidConnection = (c: any) => isValidCanvasConnection(c, edges.value)
    const load = async () => {
      nodes.value = NODES
      edges.value = EDGES
      await nextTick()
      await nextTick()
    }
    const onError = (err: any) => errors.push(err?.code ?? String(err))
    return { nodes, edges, errors, isValidConnection, load, onError, withValidation: props.withValidation }
  },
  render() {
    const s = this as any
    const attrs: Record<string, unknown> = {
      nodes: s.nodes,
      edges: s.edges,
      'apply-default': false,
      onError: s.onError,
    }
    if (s.withValidation) attrs['is-valid-connection'] = s.isValidConnection
    return h(VueFlow as any, attrs)
  },
})

async function renderWith(withValidation: boolean) {
  const w = mount(Harness, { props: { withValidation }, attachTo: document.body })
  await (w.vm as any).load()
  await flushPromises()
  await nextTick()
  const out = {
    paths: document.querySelectorAll('.vue-flow__edge-path').length,
    edgeSvg: document.querySelectorAll('.vue-flow__edges').length,
    errors: [...((w.vm as any).errors ?? [])],
  }
  w.unmount()
  return out
}

describe('CanvasPage 连线渲染（行为级守卫）', () => {
  it('加载会话时 2 条已有边全部渲染，无 EDGE_INVALID', async () => {
    const r = await renderWith(true)
    expect(r.paths).toBe(EDGES.length)
    expect(r.edgeSvg).toBe(EDGES.length)
    expect(r.errors).not.toContain('EDGE_INVALID')
  })

  it('不带校验 prop 的对照组同样渲染（排除渲染环境本身失效）', async () => {
    const r = await renderWith(false)
    expect(r.paths).toBe(EDGES.length)
  })
})

describe('isValidCanvasConnection（判据单一真源）', () => {
  const existing = EDGES

  it('回放已有边（带 id 且在本地边集）放行 —— 否则批量加载会被全量丢弃', () => {
    expect(isValidCanvasConnection({ id: 'e1', source: 'a', target: 'b' } as any, existing)).toBe(true)
    expect(isValidCanvasConnection({ id: 'e2', source: 'b', target: 'c' } as any, existing)).toBe(true)
  })

  it('历史边 id 缺失/为空仍按回放形态放行（正确性不押在数据质量上）', () => {
    expect(isValidCanvasConnection({ id: undefined, source: 'a', target: 'b' } as any, existing)).toBe(true)
    expect(isValidCanvasConnection({ id: '', source: 'a', target: 'b' } as any, existing)).toBe(true)
  })

  it('回放边即使 id 不在本地边集也放行（createGraphEdges 会补 id）', () => {
    expect(isValidCanvasConnection({ id: 'vueflow__edge-new', source: 'a', target: 'b' } as any, existing)).toBe(true)
  })

  it('新拖的同向重复 Connection 仍被拦（即时反馈不回归）', () => {
    expect(isValidCanvasConnection({ source: 'a', target: 'b' } as any, existing)).toBe(false)
  })

  it('自环、缺端点、全新连线的既有语义不变', () => {
    expect(isValidCanvasConnection({ source: 'a', target: 'a' } as any, existing)).toBe(false)
    expect(isValidCanvasConnection(null, existing)).toBe(false)
    expect(isValidCanvasConnection({ source: '', target: 'b' } as any, existing)).toBe(false)
    expect(isValidCanvasConnection({ source: 'c', target: 'a' } as any, existing)).toBe(true)
  })
})
