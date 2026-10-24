/**
 * 常驻订阅的可见性策略（2026-10-25）。
 *
 * 为什么要这个测试：**后台标签页是否真的释放连接**，靠静态 grep 是证不出来的
 * （`toContain('followUpTail.abort()')` 在「只在切会话时 abort」的旧实现里也会命中）。
 * 本测试注入 mock 订阅句柄，断言**可观测出口**：后台 ⇒ abort 被调用且 resume 不被调用。
 *
 * 生产成因（取证）：常驻订阅是会话级 SSE，断线 5s 封顶重连、永不放弃；原实现只处理
 * 「切回前台」，后台页永久占着连接。Chrome 对单 host 只有 6 条 HTTP/1.1 连接，
 * 后台页一多 + 偶发传输卡死 ⇒ 前台请求排队饿死（项目抽屉「项目加载中」转不完）。
 */
import { describe, expect, it, vi } from 'vitest'
import { applyTailVisibility, type TailVisibilityDeps } from './tail-visibility'

function makeDeps(over: Partial<TailVisibilityDeps> = {}) {
  const resume = vi.fn()
  const abort = vi.fn()
  const deps: TailVisibilityDeps = {
    isVisible: () => true,
    hasAuthToken: () => true,
    isMainStreamRunning: () => false,
    resume,
    abort,
    ...over,
  }
  return { deps, resume, abort }
}

describe('常驻订阅可见性策略 —— 后台必须释放连接', () => {
  it('后台（hidden）⇒ 掐断常驻订阅，且不重新挂起', () => {
    const { deps, resume, abort } = makeDeps({ isVisible: () => false })
    expect(applyTailVisibility(deps)).toBe('aborted')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })

  it('后台 + 本端主流在跑 ⇒ 同样掐断（旁听在主流起飞时已让位，这里只求连接归零）', () => {
    const { deps, abort } = makeDeps({ isVisible: () => false, isMainStreamRunning: () => true })
    expect(applyTailVisibility(deps)).toBe('aborted')
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('前台（visible）⇒ 恢复订阅，且不掐断（健康流不打断）', () => {
    const { deps, resume, abort } = makeDeps({ isVisible: () => true })
    expect(applyTailVisibility(deps)).toBe('resumed')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
  })

  it('前台 + 本端主流在跑 ⇒ 不动（那份文本主流自己会给，再收就是双倍）', () => {
    const { deps, resume, abort } = makeDeps({ isVisible: () => true, isMainStreamRunning: () => true })
    expect(applyTailVisibility(deps)).toBe('skipped')
    expect(resume).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
  })

  it('未登录 ⇒ 前后台都不动（订阅只会拿到 401 并连带一轮无意义退避重连）', () => {
    const hidden = makeDeps({ isVisible: () => false, hasAuthToken: () => false })
    expect(applyTailVisibility(hidden.deps)).toBe('skipped')
    expect(hidden.abort).not.toHaveBeenCalled()

    const shown = makeDeps({ isVisible: () => true, hasAuthToken: () => false })
    expect(applyTailVisibility(shown.deps)).toBe('skipped')
    expect(shown.resume).not.toHaveBeenCalled()
  })

  it('回归锁：一次裁定最多触发一个动作（不得既 abort 又 resume）', () => {
    for (const isVisible of [true, false]) {
      const { deps, resume, abort } = makeDeps({ isVisible: () => isVisible })
      applyTailVisibility(deps)
      expect(resume.mock.calls.length + abort.mock.calls.length, `isVisible=${isVisible}`).toBeLessThanOrEqual(1)
    }
  })
})
