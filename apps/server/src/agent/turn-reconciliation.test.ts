/**
 * 多端一致性 P0（规格 2026-10-21 §10 / 计划 2026-11-04 Task 2）：
 * reconcileLatestAssistant 对账三态裁决单测。
 *
 * 真相源（⭐ 不依赖已退役 getThreadState/getThreadTimeline 恒 null stub）：
 *   ① IdempotencyRecord 近窗（threadId + 30min）：processing ⇒ active、completed ⇒ settled
 *   ② runEventStream 流探测（5s 超时）：立即有增量 ⇒ active（终止事件 ⇒ settled）、空 ⇒ 降级源①
 *   ③ 双源全空 ⇒ missing
 *
 * 构造方式对齐 agent.service.answers-adjudication.test.ts。
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'

const idempotencyRecordFindMany = vi.fn()

function makeService(): AgentService {
  const service = new AgentService(
    {
      idempotencyRecord: { findMany: idempotencyRecordFindMany },
    } as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn() } as never,
  )
  return service
}

function stubProbe(
  service: AgentService,
  events: Array<Record<string, unknown>>,
  opts?: { hang?: boolean },
) {
  const spy = vi.spyOn(service, 'runEventStream').mockImplementation(async function* (
    _sessionKey: string,
    runOpts?: { signal?: AbortSignal },
  ) {
    if (opts?.hang) {
      // 模拟 retryOnMissing 404 长等待：只在探测方 abort 时才结束（对齐真实 runEventStream 行为）
      await new Promise<void>((resolve) => {
        if (runOpts?.signal) runOpts.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return
    }
    for (const e of events) yield e as never
  })
  return spy
}

const RECENT = { createdAt: new Date() }

describe('reconcileLatestAssistant', () => {
  it('IdempotencyRecord processing（近窗）⇒ active，不做探测', async () => {
    const service = makeService()
    idempotencyRecordFindMany.mockResolvedValue([
      { status: 'processing', createdAt: RECENT.createdAt },
    ])
    const probe = stubProbe(service, [])
    const r = await service.reconcileLatestAssistant('T1', 5)
    expect(r.outcome).toBe('active')
    expect(r.evidence?.idempotencyStatus).toBe('processing')
    expect(probe).not.toHaveBeenCalled() // 短路：有 processing 直接 active
  })

  it('探测立即有增量（非终止事件）⇒ active 且 lastSeq 更新', async () => {
    const service = makeService()
    idempotencyRecordFindMany.mockResolvedValue([])
    stubProbe(service, [{ type: 'text_delta', seq: 9 }])
    const r = await service.reconcileLatestAssistant('T1', 5)
    expect(r.outcome).toBe('active')
    expect(r.lastSeq).toBe(9)
  })

  it('探测拿到 turn_end 终止事件 ⇒ settled', async () => {
    const service = makeService()
    idempotencyRecordFindMany.mockResolvedValue([])
    stubProbe(service, [{ type: 'turn_end', seq: 12 }])
    const r = await service.reconcileLatestAssistant('T1', 5)
    expect(r.outcome).toBe('settled')
    expect(r.lastSeq).toBe(12)
  })

  it('探测空 + IdempotencyRecord completed ⇒ settled（带 evidence）', async () => {
    const service = makeService()
    idempotencyRecordFindMany.mockResolvedValue([
      { status: 'completed', createdAt: RECENT.createdAt },
    ])
    stubProbe(service, [])
    const r = await service.reconcileLatestAssistant('T1', 5)
    expect(r.outcome).toBe('settled')
    expect(r.evidence?.idempotencyStatus).toBe('completed')
  })

  it('探测超时降级：hang ⇒ 走 idempotency completed ⇒ settled', async () => {
    const service = makeService()
    idempotencyRecordFindMany.mockResolvedValue([
      { status: 'completed', createdAt: RECENT.createdAt },
    ])
    stubProbe(service, [], { hang: true })
    const r = await service.reconcileLatestAssistant('T1', 5)
    expect(r.outcome).toBe('settled')
  }, 10_000)

  it('双源全空 ⇒ missing', async () => {
    const service = makeService()
    idempotencyRecordFindMany.mockResolvedValue([])
    stubProbe(service, [])
    const r = await service.reconcileLatestAssistant('T1', 5)
    expect(r.outcome).toBe('missing')
  })
})
