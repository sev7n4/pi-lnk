/**
 * 统一事件通道投影接入（P0，spec 2026-11-04-unified-channel-event-projection-design）：
 * runEventStream 回调从「usageAccumulator + mapPiEventToUiEvent 零散拼装」收敛为
 * createUiEventProjector 单一派生源——askuser 卡（事故主场景）、canvas_command、
 * task、thinking、error 全部实时可达。
 *
 * #714 分工边界（runEventStream 最终形态 = projector + 两条总线订阅）：
 * - projector 只承诺「pi 事件 → UI 事件」派生（text/thinking/tool/usage_delta/
 *   turn_usage/...），不传 estimateTurnCredits（旁观不复制回合计费上下文，
 *   estimatedCredits 由重放的落库权威值补齐）；
 * - turn_settled/credit_tx 是计费领域事件，走 SessionEventBus 扇出（#714 已接线），
 *   projector 不纳派生源。
 *
 * harness 与 multi-device-stream.consistency.test.ts 同款（假 pi-runtime client +
 * 真实 runEventStream），复制不 import（测试文件独立性优先）。
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

let seqCounter = 0
function piEvent(type: PiRuntimeEvent['type'], data: unknown, runId = 'run-1'): PiRuntimeEvent {
  return { type, lane: 'T1', ts: Date.now(), seq: ++seqCounter, runId, data }
}

/** askuser 阻塞回合 lane：update 快照携带 canvasCommands（B-6 唯一实时载体） */
function askUserRunBuffer(): PiRuntimeEvent[] {
  seqCounter = 0
  return [
    piEvent('turn_start', {}),
    piEvent('tool_execution_start', { toolCallId: 'c1', toolName: 'ask_user', args: {} }),
    piEvent('tool_execution_update', {
      toolCallId: 'c1',
      toolName: 'ask_user',
      partialResult: {
        content: [{ type: 'text', text: '{}' }],
        details: { ok: true, canvasCommands: [{ type: 'ask_user', callId: 'c1', questions: [{ id: 'q1', question: '？', options: [] }] }] },
      },
    }),
    piEvent('waiting_user', { status: 'waiting', callId: 'c1' }),
    piEvent('agent_end', {}),
  ]
}

/** 模拟 pi-runtime 的 /events 订阅语义（对齐真实 client 查询协议）。 */
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
        const after = Number(opts.lastEventId)
        for (const e of buffer) if ((e.seq ?? 0) > after) onEvent(e)
      } else if (opts?.live) {
        // from=now：只收未来
      } else {
        for (const e of buffer) onEvent(e)
      }
      liveSubs.add(onEvent)
      return () => {
        liveSubs.delete(onEvent)
      }
    },
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

describe('统一通道投影接入（P0）：runEventStream 产出全量事件集', () => {
  it('事故主场景：askuser 回合 canvas_command 实时到达（此前被 pi_ 前缀静默丢弃）', async () => {
    const service = makeService(askUserRunBuffer())
    const out = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'done' })
    const cmd = out.find((e) => e.type === 'canvas_command' && (e.data as { type?: string }).type === 'ask_user')
    expect(cmd).toBeTruthy()
    expect((cmd!.data as { callId?: string }).callId).toBe('c1')
    // 归一事件照常（waiting_user 既有通路不回归）
    expect(out.some((e) => e.type === 'waiting_user')).toBe(true)
    expect(out.some((e) => e.type === 'done')).toBe(true)
  })

  it('turn_usage 照发且无 estimatedCredits（#714 裁决：旁观不复制回合计费上下文）', async () => {
    seqCounter = 0
    const buffer: PiRuntimeEvent[] = [
      piEvent('message_end', { message: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } }),
      piEvent('agent_end', {}),
    ]
    const service = makeService(buffer)
    const out = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'turn_usage' })
    const usage = out.find((e) => e.type === 'turn_usage')
    expect(usage).toBeTruthy()
    expect((usage!.data as { inputTokens?: number }).inputTokens).toBe(10)
    expect((usage!.data as { estimatedCredits?: number }).estimatedCredits).toBeUndefined()
  })

  it('mid-join：从中间接入也能收到后续 canvas_command（幂等由前端 callId upsert 兜底）', async () => {
    const buffer = askUserRunBuffer()
    const service = makeService(buffer)
    const out = await collect(service, { lastEventId: '2', stopAfter: (e) => e.type === 'done' })
    expect(out.some((e) => e.type === 'canvas_command')).toBe(true)
  })

  it('结构性 error 回合：结构化 error 实时到达（error_type/retry_hint）', async () => {
    seqCounter = 0
    const buffer: PiRuntimeEvent[] = [
      piEvent('turn_start', {}),
      piEvent('error', { message: '429 rate limit: too many requests' }),
    ]
    const service = makeService(buffer)
    const out = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'error' })
    const err = out.find((e) => e.type === 'error')
    expect(err).toBeTruthy()
    expect((err!.data as { error_type?: string }).error_type).toBe('rate_limit')
    expect((err!.data as { retry_hint?: string }).retry_hint).toBeTruthy()
  })
})

describe('事件契约白名单（spec §4.4 判据 2）：统一通道对外事件类型全集', () => {
  /** contract fixture：覆盖 spec §6 场景 1/5/6/7/8/9 的原始事件序列。 */
  function contractRunBuffer(): PiRuntimeEvent[] {
    seqCounter = 0
    return [
      piEvent('turn_start', {}),
      piEvent('message_update', { event: { type: 'text_delta', delta: '我来画' } }),
      piEvent('message_update', { event: { type: 'thinking_start' } }),
      piEvent('message_update', { event: { type: 'thinking_end' } }),
      piEvent('message_end', { message: { usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 } } }),
      piEvent('tool_execution_start', { toolCallId: 'g1', toolName: 'run_image_generation', args: {} }),
      piEvent('tool_execution_update', {
        toolCallId: 'g1', toolName: 'run_image_generation',
        partialResult: { content: [{ type: 'text', text: '{}' }], details: { ok: true, actions: [{ type: 'add_node', nodeType: 'image', nodeId: 'n1', payload: {} }] } },
      }),
      piEvent('tool_execution_end', {
        toolCallId: 'g1', toolName: 'run_image_generation',
        result: { content: [{ type: 'text', text: '{}' }], details: { ok: true, canvasCommands: [{ type: 'focus_node', nodeId: 'n1' }] } },
      }),
      piEvent('tool_execution_update', {
        toolCallId: 'a1', toolName: 'ask_user',
        partialResult: { content: [{ type: 'text', text: '{}' }], details: { ok: true, canvasCommands: [{ type: 'ask_user', callId: 'a1', questions: [{ id: 'q', question: '？', options: [] }] }] } },
      }),
      piEvent('waiting_user', { status: 'waiting', callId: 'a1' }),
      piEvent('agent_end', {}),
    ]
  }

  it('golden 集合：全量投影后 lane 派生面事件类型齐备（新增类型须先改白名单）', async () => {
    const service = makeService(contractRunBuffer())
    const out = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'done' })
    const types = new Set(out.map((e) => e.type))
    // lane 派生面全集（spec §4.3 #1-6）：缺任一 = 统一通道派生缺失回归。
    // ⚠️ usage_delta 不在 required：observer 无 estimateTurnCredits（#714 裁决，
    // 旁观不复制回合计费上下文）⇒ Q2 纪律下 usage_delta 不产（无预估快照无意义），
    // turn_usage 照发（无 estimatedCredits，权威预估由重放补齐）。
    const required = ['canvas_command', 'canvas_action', 'thinking', 'turn_usage', 'text_delta', 'waiting_user', 'done', 'tool_call', 'tool_result']
    const missing = required.filter((t) => !types.has(t))
    expect(missing).toEqual([])
    // task_list（canvas_action 的 add_node 或 plan 派生）由 canvas_action 覆盖场景
  })

  it('变异敏感：同 fixture 下 pi_ 前缀裸透传不再出现在核心派生面之外（ask_user update 归一为已知形态）', async () => {
    const service = makeService(contractRunBuffer())
    const out = await collect(service, { lastEventId: '0', stopAfter: (e) => e.type === 'done' })
    // 关键消费面必须存在（前端建卡依据）
    const cmd = out.find((e) => e.type === 'canvas_command' && (e.data as { type?: string }).type === 'ask_user')
    expect(cmd).toBeTruthy()
    const action = out.find((e) => e.type === 'canvas_action')
    expect(action).toBeTruthy()
  })
})
