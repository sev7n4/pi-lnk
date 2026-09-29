import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'

/** 最小构造（沿用 agent.service.capabilities.test.ts 的惯例）。 */
function createService() {
  return new AgentService(
    {} as never,
    { create: vi.fn() } as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn() } as never,
  )
}

/** 替换私有取址/工厂方法，避免依赖真实 env 与网络。 */
function stubPi(svc: AgentService, url: string | null, client: unknown) {
  const anySvc = svc as unknown as {
    getPiRuntimeUrl: () => string | null
    createPiRuntimeClient: (_url: string) => unknown
  }
  anySvc.getPiRuntimeUrl = () => url
  anySvc.createPiRuntimeClient = () => client
}

describe('AgentService.cancelRun（前端「停止」→ pi-runtime abort）', () => {
  it('转发到 pi-runtime 的 abortRun', async () => {
    const svc = createService()
    const abortRun = vi.fn(async () => ({ ok: true, skipped: false }))
    stubPi(svc, 'http://pi-runtime', { abortRun })

    const result = await svc.cancelRun({ sessionId: 's1' })
    expect(result).toEqual({ ok: true, skipped: false })
    expect(abortRun).toHaveBeenCalledWith('s1')
  })

  it('pi-runtime 无活跃 run 时透传 skipped（前端提示「已断开回复」）', async () => {
    const svc = createService()
    stubPi(svc, 'http://pi-runtime', { abortRun: async () => ({ ok: false, skipped: true }) })

    expect(await svc.cancelRun({ sessionId: 's1' })).toEqual({ ok: false, skipped: true })
  })

  it('未配置 pi-runtime URL 时返回 skipped，不抛（前端降级为仅断开 SSE）', async () => {
    const svc = createService()
    stubPi(svc, null, { abortRun: async () => ({ ok: true, skipped: false }) })

    expect(await svc.cancelRun({ sessionId: 's1' })).toEqual({ ok: false, skipped: true })
  })

  it('P0-①：中断目标 = 对话键（threadId），与 chat 的会话键一致', async () => {
    const svc = createService()
    const abortRun = vi.fn(async () => ({ ok: true, skipped: false }))
    stubPi(svc, 'http://pi-runtime', { abortRun })

    await svc.cancelRun({ sessionId: 's1', threadId: 's1:t9' })
    expect(abortRun).toHaveBeenCalledWith('s1:t9')
  })

  it('P0-①：threadId 为空串/空白时回落到 sessionId', async () => {
    const svc = createService()
    const abortRun = vi.fn(async () => ({ ok: true, skipped: false }))
    stubPi(svc, 'http://pi-runtime', { abortRun })

    await svc.cancelRun({ sessionId: 's1', threadId: '   ' })
    expect(abortRun).toHaveBeenCalledWith('s1')
  })
})
