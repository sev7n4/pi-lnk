import { describe, expect, it, vi } from 'vitest'
import { MembershipController } from './membership.controller'
import type { SessionEventBus } from '../points/session-event-bus.service'
import type { CreditTxEvent } from '@lnkpi/shared'

/**
 * Epic 2 Task 9（2026-11-04）：余额事件化 user 广播——SSE 端点契约。
 * 钉住：SSE 头四件套 / ready 注释帧 / user 通道订阅 / 帧写出 / close 退订 / 总线缺省即 end。
 */

function makeRes() {
  const headers = new Map<string, string>()
  const written: string[] = []
  const closeHandlers: Array<() => void> = []
  return {
    headers,
    written,
    setHeader: (k: string, v: string) => void headers.set(k, v),
    write: (chunk: string) => void written.push(chunk),
    end: vi.fn(),
    on: (event: string, fn: () => void) => {
      if (event === 'close') closeHandlers.push(fn)
    },
    closeNow: () => closeHandlers.forEach((fn) => fn()),
  }
}

type Res = ReturnType<typeof makeRes> & Record<string, unknown>

function makeBus() {
  const listeners: Array<(ev: CreditTxEvent) => void> = []
  const unsub = vi.fn()
  const subscribeUser = vi.fn((userId: string, fn: (ev: CreditTxEvent) => void) => {
    void userId
    listeners.push(fn)
    return unsub
  })
  return { bus: { subscribeUser } as unknown as SessionEventBus, listeners, unsub, subscribeUser }
}

const CREDIT_TX: CreditTxEvent = {
  type: 'credit_tx',
  data: {
    txId: 'tx-9',
    userId: 'u1',
    sessionId: 's1',
    amount: -10,
    kind: 'consume',
    category: 'text',
    reason: 'text_turn',
    balanceAfter: 90,
    ts: 1,
  },
}

describe('MembershipController.point-events（Epic 2 Task 9 user 广播）', () => {
  it('SSE 头四件套 + ready 注释帧 + 订阅本 user', async () => {
    const { bus, subscribeUser } = makeBus()
    const controller = new MembershipController({} as never, bus)
    const res = makeRes() as never as Res
    await controller.pointEvents(
      { user: { sub: 'u1' } } as never,
      res as never,
    )
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
    expect(res.written[0]).toBe(': point-events-ready\n\n')
    expect(subscribeUser).toHaveBeenCalledWith('u1', expect.any(Function))
  })

  it('user 通道事件实时写出 data 帧（balanceAfter 即权威余额）', async () => {
    const { bus, listeners } = makeBus()
    const controller = new MembershipController({} as never, bus)
    const res = makeRes() as never as Res
    await controller.pointEvents({ user: { sub: 'u1' } } as never, res as never)
    listeners[0](CREDIT_TX)
    const frame = res.written.find((w) => w.startsWith('data: {'))
    expect(frame).toBeDefined()
    expect(JSON.parse(frame!.slice(6))).toEqual(CREDIT_TX)
  })

  it('客户端 close → 退订（R1 防 emitter 泄漏）', async () => {
    const { bus, unsub } = makeBus()
    const controller = new MembershipController({} as never, bus)
    const res = makeRes() as never as Res
    await controller.pointEvents({ user: { sub: 'u1' } } as never, res as never)
    expect(unsub).not.toHaveBeenCalled()
    res.closeNow()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('总线未装配（@Optional 缺省）→ 立即 end，不建立常驻连接', async () => {
    const controller = new MembershipController({} as never, undefined)
    const res = makeRes() as never as Res
    await controller.pointEvents({ user: { sub: 'u1' } } as never, res as never)
    expect(res.end).toHaveBeenCalledTimes(1)
    expect(res.written).toEqual([])
  })
})
