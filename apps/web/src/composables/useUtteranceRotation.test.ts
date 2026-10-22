/**
 * A1 二期：金句定时轮换（A3 同批带上）
 *
 * 为什么需要：empty 相 7 条金句 > 4 个展示位，原先只靠「相变」驱动偏移
 * （AgentSideRail.vue 的 utteranceRotation watch）⇒ 用户停在同一相时，
 * 第 5~7 条永不露出，等于白写。
 *
 * 四条守卫（缺一条就出问题）：
 * 1. reduced-motion：系统要求减少动效时**完全不轮换**（不是轮慢）。
 * 2. 聚焦暂停：composer 获得焦点时暂停 —— 用户正在写字，金句在脚下跳会干扰。
 * 3. 池 <= 展示位时不轮换：偏移无意义，且会白白触发重渲染。
 * 4. 卸载清理：定时器必须随组件卸载清除，否则泄漏 + 幽灵状态更新。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick, effectScope } from 'vue'
import { useUtteranceRotation } from './useUtteranceRotation'

describe('useUtteranceRotation · 金句定时轮换', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function stubMatchMedia(reduce: boolean) {
    const listeners = new Set<(e: MediaQueryListEvent) => void>()
    const mql = {
      matches: reduce,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { listeners.add(cb) },
      removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { listeners.delete(cb) },
      dispatch: (v: boolean) => {
        mql.matches = v
        for (const cb of listeners) cb({ matches: v } as MediaQueryListEvent)
      },
      listeners,
    }
    vi.stubGlobal('matchMedia', (query: string) => (query.includes('prefers-reduced-motion') ? mql : { matches: false, addEventListener() {}, removeEventListener() {} }))
    return mql
  }

  it('按间隔推进偏移', async () => {
    stubMatchMedia(false)
    const rotation = ref(0)
    const { start } = useUtteranceRotation({
      rotation,
      intervalMs: 1000,
      poolSize: () => 7,
      visibleCount: 4,
      paused: ref(false),
    })
    start()
    expect(rotation.value).toBe(0)
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(rotation.value).toBe(1)
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(rotation.value).toBe(2)
  })

  it('池 <= 展示位时不启动轮换（偏移无意义）', () => {
    stubMatchMedia(false)
    const rotation = ref(0)
    const { start } = useUtteranceRotation({
      rotation,
      intervalMs: 1000,
      poolSize: () => 3,
      visibleCount: 4,
      paused: ref(false),
    })
    start()
    vi.advanceTimersByTime(5000)
    expect(rotation.value).toBe(0)
  })

  it('reduced-motion 时完全不轮换', () => {
    stubMatchMedia(true)
    const rotation = ref(0)
    const { start } = useUtteranceRotation({
      rotation,
      intervalMs: 1000,
      poolSize: () => 7,
      visibleCount: 4,
      paused: ref(false),
    })
    start()
    vi.advanceTimersByTime(10000)
    expect(rotation.value).toBe(0)
  })

  it('暂停时不推进；解除暂停后恢复', async () => {
    stubMatchMedia(false)
    const rotation = ref(0)
    const paused = ref(false)
    const { start } = useUtteranceRotation({
      rotation,
      intervalMs: 1000,
      poolSize: () => 7,
      visibleCount: 4,
      paused,
    })
    start()
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(rotation.value).toBe(1)

    paused.value = true
    vi.advanceTimersByTime(5000)
    await nextTick()
    expect(rotation.value).toBe(1)

    paused.value = false
    // ⚠️ watch 是异步的（flush:'pre'）：必须先让它跑完重建定时器，再推进时间。
    // 顺序反了会看到「恢复后第一拍没走」—— 那是测试时序问题，不是实现问题。
    await nextTick()
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(rotation.value).toBe(2)
  })

  it('stop 后不再推进（卸载清理）', async () => {
    stubMatchMedia(false)
    const rotation = ref(0)
    const { start, stop } = useUtteranceRotation({
      rotation,
      intervalMs: 1000,
      poolSize: () => 7,
      visibleCount: 4,
      paused: ref(false),
    })
    start()
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(rotation.value).toBe(1)
    stop()
    vi.advanceTimersByTime(5000)
    await nextTick()
    expect(rotation.value).toBe(1)
  })

  it('系统中途切换 reduced-motion → 立即停止轮换', async () => {
    const mql = stubMatchMedia(false)
    const rotation = ref(0)
    const { start } = useUtteranceRotation({
      rotation,
      intervalMs: 1000,
      poolSize: () => 7,
      visibleCount: 4,
      paused: ref(false),
    })
    start()
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(rotation.value).toBe(1)

    mql.dispatch(true)
    await nextTick()
    vi.advanceTimersByTime(5000)
    await nextTick()
    expect(rotation.value).toBe(1)
  })

  it('reduced-motion 从 true 切到 false → 恢复轮换', async () => {
    const mql = stubMatchMedia(true)
    const rotation = ref(0)
    const { start } = useUtteranceRotation({
      rotation,
      intervalMs: 1000,
      poolSize: () => 7,
      visibleCount: 4,
      paused: ref(false),
    })
    start()
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(rotation.value).toBe(0)

    mql.dispatch(false)
    await nextTick()
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(rotation.value).toBe(1)
  })

  it('组件卸载后定时器被清除（不是只有手动 stop 才清）', async () => {
    stubMatchMedia(false)
    const rotation = ref(0)
    // ⚠️ 只测 stop() 是不够的：真实卸载走的是 onUnmounted ⇒ 必须用 effectScope
    // 触发真正的生命周期，否则「卸载清理」这条守卫等于没测。
    const scope = effectScope()
    scope.run(() => {
      useUtteranceRotation({
        rotation,
        intervalMs: 1000,
        poolSize: () => 7,
        visibleCount: 4,
        paused: ref(false),
      }).start()
    })
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(rotation.value).toBe(1)

    scope.stop() // 触发 onUnmounted → stop()
    vi.advanceTimersByTime(5000)
    await nextTick()
    expect(rotation.value).toBe(1)
  })

  it('无 matchMedia 宿主（SSR / 老浏览器）时按「不轮换」处理，不抛错', () => {
    // ⚠️ jsdom **自带** matchMedia（matches 恒 false）⇒ 只 unstub 不够，
    // 必须真正把 window.matchMedia 置 undefined 才算「无此 API 的宿主」。
    vi.stubGlobal('matchMedia', undefined)
    const rotation = ref(0)
    const { start } = useUtteranceRotation({
      rotation,
      intervalMs: 1000,
      poolSize: () => 7,
      visibleCount: 4,
      paused: ref(false),
    })
    expect(() => start()).not.toThrow()
    vi.advanceTimersByTime(5000)
    expect(rotation.value).toBe(0)
  })
})
