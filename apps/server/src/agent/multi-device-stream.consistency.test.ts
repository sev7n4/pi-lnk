/**
 * 多端一致性 P0+P1 集成（规格 2026-10-21 §10 / 计划 2026-11-04 Task 7）：
 * 同一账号多端看到的事件流一致 —— 验收判据映射：
 *
 *  判据 1（双端逐条相同）：发起端 A 与旁观端 B 消费**同一条** GET /runs/events
 *        通道（P1 统一传输后主流与旁听本就同源），对同一份 lane buffer 的事件
 *        序列逐条相同（type + data + seq 比对）。
 *  判据 2（断 A 连接后 B 补齐）：B 迟到连入（带游标）→ 只补增量不重放、不漏帧；
 *        reconcileLatestAssistant 非 missing（run 完结 ⇒ settled、进行中 ⇒ active）。
 *  判据 3（from=now 语义）：不带游标 ⇒ 只收未来 —— 这正是 ack 必须携带
 *        sinceSeq 锚点的结构性理由（否则 ack 与订阅之间的窗口整段丢失）。
 *
 * 实现口径：假 pi-runtime client（内存 lane buffer + 三种订阅语义，行为对齐
 * pi-runtime.client.streamEvents 的真实查询协议 lastEventId / from=now / 全量），
 * 驱动**真实**的 AgentService.runEventStream（mapPiEventToUiEvent 归一）与
 * reconcileLatestAssistant（双源裁决真实执行，IdempotencyRecord 空 ⇒ 走流探测）。
 *
 * ⚠️ 计划偏离注记：计划路径为 `apps/server/test/integration/*.spec.ts`，实际落在
 * `src/agent/*.test.ts` —— 本仓 vitest include 只覆盖 src，且与既有 agent 测试
 * 共用 harness 纪律（nvm node24 + maxWorkers=1）。
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

// ── 假 pi-runtime：内存 lane buffer + 真实查询协议 ─────────────────────────────

let seqCounter = 0
function piEvent(type: PiRuntimeEvent['type'], data: unknown, runId = 'run-1'): PiRuntimeEvent {
  return { type, lane: 'T1', ts: Date.now(), seq: ++seqCounter, runId, data }
}

/** 一条已完成回合的 lane：start → delta×2 → tool → end → turn_end */
function completedRunBuffer(): PiRuntimeEvent[] {
  seqCounter = 0
  return [
    piEvent('turn_start', {}),
    // ⭐ 真实形状：delta 内嵌在 data.event（extractTextDelta 契约），裸 {delta} 会被丢
    piEvent('message_update', { event: { type: 'text_delta', delta: '正在' } }),
    piEvent('message_update', { event: { type: 'text_delta', delta: '画车' } }),
    piEvent('tool_execution_start', { toolCallId: 'c1', toolName: 'run_image_generation', args: {} }),
    piEvent('agent_end', {}),
    piEvent('turn_end', {}),
  ]
}

/** 模拟 pi-runtime 的 /events 订阅语义（对齐真实 client 的查询协议）。 */
function makeFakePiRuntime(buffer: PiRuntimeEvent[]) {
  const liveSubs = new Set<(e: PiRuntimeEvent) => void>()
  const client = {
    streamEvents: (
      _sessionId: string,
      onEvent: (e: PiRuntimeEvent) => void,
      _onError?: (err: unknown) => void,
      opts?: { live?: boolean; lastEventId?: string },
    ): (() => void) => {
      if (opts?.lastEventId !== undefined) {
        // 断点续传：只重放 seq > lastEventId 的缓冲（不重放、不漏帧）
        const after = Number(opts.lastEventId)
        for (const e of buffer) if ((e.seq ?? 0) > after) onEvent(e)
      } else if (opts?.live) {
        // from=now：只收未来（缓冲一概不给 —— 语义判据 3）
      } else {
        // 无参数：全量重放
        for (const e of buffer) onEvent(e)
      }
      liveSubs.add(onEvent)
      return () => {
        liveSubs.delete(onEvent)
      }
    },
    /** run 推进：向 buffer 追加并广播给 live 订阅者。 */
    push: (e: PiRuntimeEvent): void => {
      buffer.push(e)
      for (const sub of [...liveSubs]) sub(e)
    },
  }
  return client
}

function makeService(buffer: PiRuntimeEvent[]): AgentService {
  const service = new AgentService(
    { idempotencyRecord: { findMany: vi.fn().mockResolvedValue([]) } } as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn() } as never,
  )
  const s = service as unknown as Record<string, unknown>
  s.getPiRuntimeUrl = vi.fn().mockReturnValue('http://pi-runtime')
  s.createPiRuntimeClient = vi.fn().mockReturnValue(makeFakePiRuntime(buffer))
  return service
}

async function collect(
  service: AgentService,
  opts: { lastEventId?: string; stopAfter?: (ev: { type: string }) => boolean },
): Promise<Array<{ type: string; data: unknown; seq?: number }>> {
  const out: Array<{ type: string; data: unknown; seq?: number }> = []
  const ac = new AbortController()
  for await (const ev of service.runEventStream('T1', { lastEventId: opts.lastEventId, signal: ac.signal })) {
    const e = ev as { type: string; data: unknown; seq?: number }
    out.push({ type: e.type, data: e.data, seq: e.seq })
    if (opts.stopAfter?.(e)) {
      ac.abort()
      break
    }
  }
  return out
}

describe('多端一致性集成（规格 §10 判据，真实 runEventStream + reconcile）', () => {
  it('判据 1：发起端 A（游标 0）与旁观端 B（迟连，游标 0）事件序列逐条相同', async () => {
    const buffer = completedRunBuffer()
    const service = makeService(buffer)

    const streamA = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'pi_turn_end' })
    const streamB = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'pi_turn_end' })

    expect(streamA.length).toBe(buffer.length)
    expect(streamB).toEqual(streamA) // type + data + seq 逐条相同
    // seq 完整性：A/B 都拿到单调游标（id: 帧的原材料 —— 去 seq 即断链）
    expect(streamA.map((e) => e.seq)).toEqual(buffer.map((e) => e.seq))
  })

  it('判据 2：B 迟到连入（游标=3）只补增量不重放；并集 = 全量（断 A 连接不丢帧）', async () => {
    const buffer = completedRunBuffer()
    const service = makeService(buffer)

    const head = await collect(service, { lastEventId: '0', stopAfter: (e) => e.seq === 3 })
    const tail = await collect(service, { lastEventId: '3', stopAfter: (e) => e.type === 'pi_turn_end' })

    expect(head.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(tail.map((e) => e.seq)).toEqual([4, 5, 6]) // 不重放 1..3
    const full = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'pi_turn_end' })
    expect([...head, ...tail]).toEqual(full)
  })

  it('判据 3：不带游标（from=now）只收未来事件 —— ack 必须带 sinceSeq 的结构性理由', async () => {
    const buffer = completedRunBuffer()
    const service = makeService(buffer)

    // live 订阅先挂上（from=now）：缓冲里的 6 条一概不给
    const liveGot: string[] = []
    const ac = new AbortController()
    const consuming = (async () => {
      for await (const ev of service.runEventStream('T1', { signal: ac.signal })) {
        liveGot.push((ev as { type: string }).type)
        if (liveGot.length >= 1) {
          ac.abort()
          break
        }
      }
    })()
    await new Promise((r) => setTimeout(r, 10))
    // 此时 run 推进一条新事件 → live 订阅者收到；缓冲旧事件不会冒出来
    const s = service as unknown as Record<string, unknown>
    ;(s.createPiRuntimeClient as (url: string) => ReturnType<typeof makeFakePiRuntime>)('http://x').push(
      piEvent('message_update', { event: { type: 'text_delta', delta: '新帧' } }),
    )
    await consuming
    expect(liveGot).toEqual(['text_delta']) // 只有一帧（新事件归一后的 delta）
  })

  it('判据 2 续：run 完结后 reconcile 非 missing（⇒ settled），进行中 ⇒ active', { timeout: 20_000 }, async () => {
    // ⭐ probe 语义（Task 7 实证修订）：消费重放至**终态帧**（pi agent_end→done /
    //    pi turn_end→pi_turn_end）⇒ settled；active 场景（无终态）等满 5s 探测窗。
    const doneBuffer = completedRunBuffer()
    const settled = await makeService(doneBuffer).reconcileLatestAssistant('T1', 0)
    expect(settled.outcome).toBe('settled')
    expect(settled.lastSeq).toBe(5) // probe 在 done（seq5，真实映射终态）即返回

    const activeBuffer = completedRunBuffer().slice(0, 4) // 跑到一半（无终态帧）
    const active = await makeService(activeBuffer).reconcileLatestAssistant('T1', 0)
    expect(active.outcome).toBe('active')
    expect(active.lastSeq).toBe(4)
  })

  it('变异守卫：服务端丢 seq（去 id: 帧的等价形态）⇒ 迟连游标失效面暴露（红）', async () => {
    // 语义：Nest runEvents 的 `id: ${seq}` 与 mapPiEventToUiEvent 的 seq 透传是
    // 游标续传的原材料；本断言锁「事件必须携带 seq」——上游丢了 seq，B 的
    // 断点续传窗口计算（seq > lastEventId）立即失真 ⇒ 全量重放/漏帧。
    const buffer = completedRunBuffer()
    const service = makeService(buffer)
    const streamB = await collect(service, { lastEventId: '3', stopAfter: (e) => e.type === 'pi_turn_end' })
    for (const e of streamB) expect(typeof e.seq).toBe('number')
  })
})
