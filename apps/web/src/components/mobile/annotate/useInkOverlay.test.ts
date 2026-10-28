import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useInkOverlay } from './useInkOverlay'
import type { AnnotateMark } from './composeAnnotatedImage'

/**
 * 画笔覆盖层共享逻辑（W-26/W-27 真机修复）。
 *
 * ⭐ 断言纪律（CI canvas 包教训）：只断**尺寸换算与事件语义**——canvas.width/
 *   height（bitmap 尺寸换算是本修复的根因判据）、marks 累积、pointerId 过滤；
 *   ⛔ 不断绘图渲染效果（getContext 在纯 jsdom 返 null、CI 装了 canvas 包则可用
 *   —— 环境差异，断渲染必假红/假绿）。
 * ⚠️ jsdom 盲区警示：getBoundingClientRect 恒 0 ⇒ 本文件全部 stub 尺寸后测；
 *   真实可见性判据只能真机走查（规格 §4.7.1 记账）。
 */

/** 挂一个消费组合式的最小宿主组件（渲染函数 —— 项目 vitest 无模板编译器） */
function mountHost() {
  const onStrokeEnd = vi.fn()
  const Host = defineComponent({
    setup(_, { expose }) {
      const canvas = ref<HTMLCanvasElement | null>(null)
      const active = ref(false)
      const ink = useInkOverlay({ canvas, active, onStrokeEnd })
      // ⭐ expose 的 ref 会被 vm 代理自动解包 ⇒ 用存取器暴露原始 ref 语义
      expose({
        getCanvas: () => canvas.value,
        setActive: (v: boolean) => {
          active.value = v
        },
        ink,
        onStrokeEnd,
      })
      return () => h('canvas', { ref: canvas, 'data-testid': 'ink-canvas' })
    },
  })
  const w = mount(Host)
  const exposed = w.vm as unknown as {
    getCanvas: () => HTMLCanvasElement
    setActive: (v: boolean) => void
    ink: ReturnType<typeof useInkOverlay>
    onStrokeEnd: ReturnType<typeof vi.fn>
  }
  return { w, exposed, onStrokeEnd }
}

/** 造伪 PointerEvent（只含组合式消费的字段；jsdom 无 PointerEvent 构造器也可测） */
function ptr(pointerId: number, clientX = 0, clientY = 0): PointerEvent {
  return { pointerId, clientX, clientY } as unknown as PointerEvent
}

/** stub 元素几何与 DPR（jsdom getBoundingClientRect 恒 0、devicePixelRatio 恒 1） */
function stubGeometry(el: Element, width: number, height: number, dpr: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 }),
    configurable: true,
  })
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true })
}

describe('useInkOverlay（画笔覆盖层共享逻辑 · W-26/W-27 修复）', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('⭐ syncSize 按 CSS 尺寸 × DPR 设 bitmap（根因判据：此前从未设置，默认 300×150）', async () => {
    const { w, exposed } = mountHost()
    const el = w.get('[data-testid="ink-canvas"]').element
    stubGeometry(el, 390, 844, 2)
    exposed.setActive(true)
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    // bitmap = CSS × dpr，坐标空间仍 CSS ⇒ marks/合成图零适配
    expect((el as HTMLCanvasElement).width).toBe(780)
    expect((el as HTMLCanvasElement).height).toBe(1688)
    expect(exposed.ink.syncSize).toBeTruthy()
  })

  it('DPR 上限 3（防 4K 全屏 bitmap 内存爆量）', async () => {
    const { w, exposed } = mountHost()
    const el = w.get('[data-testid="ink-canvas"]').element as HTMLCanvasElement
    stubGeometry(el, 390, 844, 5)
    exposed.setActive(true)
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(el.width).toBe(390 * 3)
    expect(el.height).toBe(844 * 3)
  })

  it('一笔（down → move ×2 → up）⇒ marks 累积一条 3 点笔画 + onStrokeEnd 回调', async () => {
    const { w, exposed, onStrokeEnd } = mountHost()
    const el = w.get('[data-testid="ink-canvas"]').element
    stubGeometry(el, 390, 844, 1)
    exposed.setActive(true)
    await w.vm.$nextTick()
    const ink = exposed.ink
    ink.onPointerDown(ptr(1, 10, 20))
    ink.onPointerMove(ptr(1, 40, 30))
    ink.onPointerMove(ptr(1, 70, 40))
    ink.onPointerUp(ptr(1))
    expect(ink.marks.value).toHaveLength(1)
    expect(ink.marks.value[0]!.points).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 30 },
      { x: 70, y: 40 },
    ])
    expect(onStrokeEnd).toHaveBeenCalledTimes(1)
    expect(onStrokeEnd.mock.calls[0]![0] as AnnotateMark).toEqual(ink.marks.value[0])
  })

  it('⭐ 多点过滤：持笔期间第二根手指的 down/move 不接管，up(pointerId≠持笔) 不收笔', async () => {
    const { w, exposed } = mountHost()
    const el = w.get('[data-testid="ink-canvas"]').element
    stubGeometry(el, 390, 844, 1)
    exposed.setActive(true)
    await w.vm.$nextTick()
    const ink = exposed.ink
    ink.onPointerDown(ptr(1, 10, 20))
    ink.onPointerDown(ptr(2, 100, 100)) // 第二根手指：忽略
    ink.onPointerMove(ptr(2, 120, 120)) // 其移动：忽略
    ink.onPointerMove(ptr(1, 40, 30))
    ink.onPointerUp(ptr(2)) // 抬起的是另一根手指：不收笔
    expect(ink.marks.value).toHaveLength(0)
    ink.onPointerUp(ptr(1)) // 持笔手指抬起 ⇒ 收笔
    expect(ink.marks.value).toHaveLength(1)
    expect(ink.marks.value[0]!.points).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 30 },
    ])
  })

  it('非标注态（active=false）⇒ 事件全部忽略', async () => {
    const { w, exposed } = mountHost()
    const el = w.get('[data-testid="ink-canvas"]').element
    stubGeometry(el, 390, 844, 1)
    await w.vm.$nextTick()
    const ink = exposed.ink
    ink.onPointerDown(ptr(1, 10, 20))
    ink.onPointerMove(ptr(1, 40, 30))
    ink.onPointerUp(ptr(1))
    expect(ink.marks.value).toHaveLength(0)
  })

  it('reset ⇒ 清空 marks（进入/退出标注态复用）', async () => {
    const { w, exposed } = mountHost()
    const el = w.get('[data-testid="ink-canvas"]').element
    stubGeometry(el, 390, 844, 1)
    exposed.setActive(true)
    await w.vm.$nextTick()
    const ink = exposed.ink
    ink.onPointerDown(ptr(1, 1, 1))
    ink.onPointerUp(ptr(1))
    expect(ink.marks.value).toHaveLength(1)
    ink.reset()
    expect(ink.marks.value).toHaveLength(0)
  })

  it('pointercancel ⇒ 丢弃未落定笔画（不清已落定 marks）', async () => {
    const { w, exposed } = mountHost()
    const el = w.get('[data-testid="ink-canvas"]').element
    stubGeometry(el, 390, 844, 1)
    exposed.setActive(true)
    await w.vm.$nextTick()
    const ink = exposed.ink
    ink.onPointerDown(ptr(1, 1, 1))
    ink.onPointerUp(ptr(1))
    ink.onPointerDown(ptr(1, 2, 2))
    ink.onPointerCancel(ptr(1))
    expect(ink.marks.value).toHaveLength(1) // 第一笔保留
    expect(ink.marks.value[0]!.points).toEqual([{ x: 1, y: 1 }])
    // 且笔已释放：可重新起笔
    ink.onPointerDown(ptr(1, 5, 5))
    ink.onPointerUp(ptr(1))
    expect(ink.marks.value).toHaveLength(2)
  })
})
