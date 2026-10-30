import { describe, expect, it, vi } from 'vitest'
import { CACHEABLE_GET_PATHS, NoCacheInterceptor, isCacheablePath } from './no-cache.interceptor'

function makeCtx(method: string, originalUrl: string) {
  const res = { setHeader: vi.fn() }
  const ctx = { switchToHttp: () => ({ getRequest: () => ({ method, originalUrl }), getResponse: () => res }) }
  return { ctx, res }
}

const passthrough = { handle: () => 'next' } as never

describe('isCacheablePath', () => {
  it('空白名单恒 false（K1：默认全禁）', () => {
    expect(CACHEABLE_GET_PATHS).toEqual([])
    expect(isCacheablePath('/api/works')).toBe(false)
  })
  it('白名单精确与前缀匹配，且不做意外子串匹配', () => {
    expect(isCacheablePath('/api/exports/x', ['/api/exports'])).toBe(true)
    expect(isCacheablePath('/api/exportsfoo', ['/api/exports'])).toBe(false)
  })
  it('大小写敏感匹配（§8-③：/api/Exports/x 不命中白名单 /api/exports）', () => {
    expect(isCacheablePath('/api/Exports/x', ['/api/exports'])).toBe(false)
  })
})

describe('NoCacheInterceptor', () => {
  it('动态 GET 注入 Cache-Control: no-store（S2 的服务端半边）', () => {
    const { ctx, res } = makeCtx('GET', '/api/agent/chat/threads?sessionId=s1')
    new NoCacheInterceptor().intercept(ctx as never, passthrough)
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
  it('非 GET 不注入', () => {
    const { ctx, res } = makeCtx('POST', '/api/agent/chat/conversation')
    new NoCacheInterceptor().intercept(ctx as never, passthrough)
    expect(res.setHeader).not.toHaveBeenCalled()
  })
  it('白名单路径不注入（构造注入，可测）', () => {
    const { ctx, res } = makeCtx('GET', '/api/exports/doc.pdf')
    new NoCacheInterceptor(['/api/exports']).intercept(ctx as never, passthrough)
    expect(res.setHeader).not.toHaveBeenCalled()
  })
})
