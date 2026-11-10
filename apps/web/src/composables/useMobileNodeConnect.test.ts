import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  useMobileNodeConnect,
  registerConnectHandler,
  __resetMobileConnectForTest,
  buildConnection,
} from './useMobileNodeConnect'

/**
 * 连线模式状态机守卫（模块级单例模型）。
 * ⭐ 变异自检：断言精确——未进入模式 complete 不调用（删 guard ⇒ RED）、
 * 自环被拦截（删 === 判定 ⇒ RED）、registerConnectHandler 未注册时 complete 不抛错
 * （删空值守卫 ⇒ 静默失败）、切换源只更新（删 enter 覆盖 ⇒ RED）。
 */
describe('useMobileNodeConnect（模块级单例）', () => {
  beforeEach(() => __resetMobileConnectForTest())

  it('buildConnection 语义与 PC 边一致', () => {
    const c = buildConnection('a', 'b')
    expect(c).toMatchObject({
      source: 'a',
      target: 'b',
      sourceHandle: 'source',
      targetHandle: 'target',
    })
  })

  it('enter 设 pendingSource（单例共享）', () => {
    const m = useMobileNodeConnect()
    m.enter('a')
    expect(m.pendingSource.value).toBe('a')
  })

  it('complete 经 registerConnectHandler 落库回调并清空 pending', () => {
    const onC = vi.fn()
    registerConnectHandler(onC)
    const m = useMobileNodeConnect()
    m.enter('a')
    m.complete('b')
    expect(onC).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'a', target: 'b' }),
    )
    expect(m.pendingSource.value).toBeNull()
  })

  it('R-C3 自环拦截：complete(源) 不建边', () => {
    const onC = vi.fn()
    registerConnectHandler(onC)
    const m = useMobileNodeConnect()
    m.enter('a')
    m.complete('a')
    expect(onC).not.toHaveBeenCalled()
    expect(m.pendingSource.value).toBeNull()
  })

  it('cancel 清空 pending', () => {
    const m = useMobileNodeConnect()
    m.enter('a')
    m.cancel()
    expect(m.pendingSource.value).toBeNull()
  })

  it('切换源：再 enter 不同源只更新不退出', () => {
    const m = useMobileNodeConnect()
    m.enter('a')
    m.enter('c')
    expect(m.pendingSource.value).toBe('c')
  })

  it('未进入模式时 complete 无操作', () => {
    const onC = vi.fn()
    registerConnectHandler(onC)
    const m = useMobileNodeConnect()
    m.complete('b')
    expect(onC).not.toHaveBeenCalled()
  })

  it('未注册落库回调时 complete 不抛错（降级安全）', () => {
    const m = useMobileNodeConnect()
    m.enter('a')
    expect(() => m.complete('b')).not.toThrow()
    expect(m.pendingSource.value).toBeNull()
  })
})
