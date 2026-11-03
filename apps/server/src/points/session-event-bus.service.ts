import { Injectable } from '@nestjs/common'
import { EventEmitter } from 'events'
import type { CreditTxEvent } from '@lnkpi/shared'

export type CreditTxListener = (ev: CreditTxEvent['data']) => void

/**
 * Epic 1（spec 2026-11-03-credit-consumption-display-design §5.1）：会话级积分变动事件总线。
 *
 * 职责单一：把 `PointsService` 在计费事务提交后发出的 `credit_tx` 领域事件，路由到
 * - 指定会话的在飞 SSE 流（`sessionEmitters`，用于对话内实时累计）
 * - 该用户所有打开的会话/标签（`userEmitters`，用于余额跨标签同步，Epic 2 预备）
 *
 * ⚠️ 不直接依赖会话层 / SSE 生成器：它只提供订阅与发射原语，`streamConversation`
 * 负责在流建立时订阅、流结束时退订（防 emitter 泄漏，R1）。退化语义（CREDIT_TX=off）
 * 由调用方控制，本服务无 flag 概念。
 */
@Injectable()
export class SessionEventBus {
  private readonly sessionEmitters = new Map<string, EventEmitter>()
  private readonly userEmitters = new Map<string, EventEmitter>()

  /** PointsService 在 pointTransaction.create 事务提交后调用。失败不抛（调用方已 try/warn）。 */
  emitCreditTx(ev: CreditTxEvent['data']): void {
    const sessionEmitter = ev.sessionId ? this.sessionEmitters.get(ev.sessionId) : undefined
    if (sessionEmitter) sessionEmitter.emit('credit_tx', ev)
    // 始终同步推给该用户所有打开的会话（C2 多标签 / Epic 2 预备）
    this.userEmitters.get(ev.userId)?.emit('credit_tx', ev)
  }

  /** streamConversation 在流建立时订阅本会话；结束时调用返回函数退订。 */
  subscribeSession(sessionId: string, fn: CreditTxListener): () => void {
    return this.subscribe(this.sessionEmitters, sessionId, fn)
  }

  /** 任意会话流订阅本用户广播（余额跨标签同步）；结束时退订。 */
  subscribeUser(userId: string, fn: CreditTxListener): () => void {
    return this.subscribe(this.userEmitters, userId, fn)
  }

  private subscribe(
    registry: Map<string, EventEmitter>,
    key: string,
    fn: CreditTxListener,
  ): () => void {
    let emitter = registry.get(key)
    if (!emitter) {
      emitter = new EventEmitter()
      // 允许任意多订户（多设备 / 多标签同时打开）
      emitter.setMaxListeners(0)
      registry.set(key, emitter)
    }
    // 去重：同一 fn 重复订阅只计一次（防双通道同流重复计数）
    if (!emitter.listeners('credit_tx').includes(fn)) {
      emitter.on('credit_tx', fn)
    }
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      emitter!.removeListener('credit_tx', fn)
      if (emitter!.listenerCount('credit_tx') === 0) {
        registry.delete(key)
      }
    }
  }
}
