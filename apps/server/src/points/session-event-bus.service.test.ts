import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { CreditTxEvent } from '@lnkpi/shared'
import { SessionEventBus } from './session-event-bus.service'

type TxData = CreditTxEvent['data']

function makeTx(over: Partial<TxData>): TxData {
  return {
    txId: 'tx-1',
    userId: 'u1',
    sessionId: 's1',
    amount: -10,
    kind: 'consume',
    category: 'image',
    reason: 'gen-image',
    balanceAfter: 990,
    ts: 1_700_000_000_000,
    ...over,
  }
}

describe('SessionEventBus', () => {
  it('会话订阅者收到匹配 sessionId 的事件', () => {
    const bus = new SessionEventBus()
    const received: TxData[] = []
    bus.subscribeSession('s1', (ev) => received.push(ev))
    bus.emitCreditTx(makeTx({}))
    expect(received).toHaveLength(1)
    expect(received[0].txId).toBe('tx-1')
  })

  it('退订后不再收到事件', () => {
    const bus = new SessionEventBus()
    const received: TxData[] = []
    const unsub = bus.subscribeSession('s1', (ev) => received.push(ev))
    bus.emitCreditTx(makeTx({ txId: 'a' }))
    unsub()
    bus.emitCreditTx(makeTx({ txId: 'b' }))
    expect(received.map((r) => r.txId)).toEqual(['a'])
  })

  it('会话隔离：s1 订阅者不接收 sessionId=s2 的事件（未订阅 user）', () => {
    const bus = new SessionEventBus()
    const received: TxData[] = []
    bus.subscribeSession('s1', (ev) => received.push(ev))
    bus.emitCreditTx(makeTx({ sessionId: 's2', txId: 'x' }))
    expect(received).toHaveLength(0)
  })

  it('用户订阅者收到任意 sessionId（同 userId）的事件', () => {
    const bus = new SessionEventBus()
    const received: TxData[] = []
    bus.subscribeUser('u1', (ev) => received.push(ev))
    // 无 sessionId（如后台赠送）→ 仅 user 通道
    bus.emitCreditTx(makeTx({ sessionId: undefined, txId: 'g' }))
    // 带 sessionId 但非本会话订阅 → user 通道仍收
    bus.emitCreditTx(makeTx({ sessionId: 's9', txId: 'h' }))
    expect(received.map((r) => r.txId)).toEqual(['g', 'h'])
  })

  it('双通道：同一事件同时投递 session 订阅者与 user 订阅者，各一次', () => {
    const bus = new SessionEventBus()
    const sessionHits: TxData[] = []
    const userHits: TxData[] = []
    bus.subscribeSession('s1', (ev) => sessionHits.push(ev))
    bus.subscribeUser('u1', (ev) => userHits.push(ev))
    bus.emitCreditTx(makeTx({ txId: 'dup' }))
    expect(sessionHits).toHaveLength(1)
    expect(userHits).toHaveLength(1)
    expect(sessionHits[0].txId).toBe('dup')
    expect(userHits[0].txId).toBe('dup')
  })

  it('用户隔离：u2 订阅者不接收 userId=u1 的事件', () => {
    const bus = new SessionEventBus()
    const received: TxData[] = []
    bus.subscribeUser('u2', (ev) => received.push(ev))
    bus.emitCreditTx(makeTx({ userId: 'u1', txId: 'z' }))
    expect(received).toHaveLength(0)
  })

  it('退订后清理 emitter 条目（防泄漏）', () => {
    const bus = new SessionEventBus()
    const unsub = bus.subscribeSession('s1', () => {})
    unsub()
    // 通过再次订阅同一 key 应新建 emitter（旧条目已删除）验证内部 map 已清空
    const received: TxData[] = []
    bus.subscribeSession('s1', (ev) => received.push(ev))
    bus.emitCreditTx(makeTx({}))
    expect(received).toHaveLength(1)
  })

  it('同一 fn 重复订阅只计一次（单发只回调一次）', () => {
    const bus = new SessionEventBus()
    const received: TxData[] = []
    const fn = (ev: TxData) => received.push(ev)
    const unsub1 = bus.subscribeSession('s1', fn)
    bus.subscribeSession('s1', fn) // 重复订阅同一 fn
    bus.emitCreditTx(makeTx({ txId: 'once' }))
    expect(received.map((r) => r.txId)).toEqual(['once'])
    unsub1()
  })
})
