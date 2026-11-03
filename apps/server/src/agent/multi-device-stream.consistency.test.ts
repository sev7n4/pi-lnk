/**
 * 多端一致性 P1 · 双端一致性集成（计划 2026-11-04 Task 7，Nest 层等价形态）。
 *
 * 验收（规格 §10）的可测核心：
 *  1. **A/B 同游标逐条相同**：同一 (thread, sinceSeq) 开两个订阅（模拟发起端
 *     主流消费与旁观端常驻订阅——P1 后两者读**同一条** GET /runs/events 通道），
 *     事件序列 type+data 逐条相等，无漏无重（plan Review Focus 3）。
 *  2. **A 强断 ≠ 失败**：run 事件已在 lane buffer ⇒ reconcileLatestAssistant
 *     流探测立即续到事件 ⇒ outcome=active/settled（非 missing）——红车根因
 *     防线（2026-11-01 误报双图）在 ack 架构下依旧闭合。
 *  3. **ack 锚点无漏**：头探针读 pre-run head ⇒ B 以 sinceSeq 订阅只收本 run
 *     事件，pre-run buffer 不重放（无重复刷屏）、run 事件不缺（重放补齐竞态）。
 *
 * pi-runtime 桩：内存 buffer + live 订阅者集合，prompt() 异步逐条入 buffer 并
 * 推送（语义对齐 services/pi-runtime 的 `subscribe(afterSeq)`：重放 seq>after
 * + live 增量；无 lastEventId + live ⇒ from=now 只收未来）。
 * （变异三件套在 web 侧 main-turn-channel.mutation.test.ts：被变异对象
 * consumeMainTurnStream / backoffWithJitter 属 web 模块，跨包导入不可行。）
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { piEvent } from './agent.test-utils'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

type Fn = (...a: unknown[]) => unknown

/** 内存 lane 桩：buffer + live 集合 + prompt 触发的 run 事件流。 */
function makeLaneStub(preBuffer: PiRuntimeEvent[], runEvents: PiRuntimeEvent[]) {
  const buffer = [...preBuffer]
  const live = new Set<(e: PiRuntimeEvent) => void>()
  return {
    buffer,
    healthz: vi.fn().mockResolvedValue({ status: 'ok', sessions: 1 }),
    createSession: vi
      .fn()
      .mockResolvedValue({ sessionId: 'x', provider: 'agnes', model: 'm', status: 'created' }),
    prompt: vi.fn().mockImplementation(async () => {
      for (const ev of runEvents) {
        await new Promise((r) => setTimeout(r, 15))
        buffer.push(ev)
        for (const fn of [...live]) fn(ev)
      }
    }),
    steer: vi.fn().mockResolvedValue({ queued: true }),
    followUp: vi.fn().mockResolvedValue({ queued: true }),
    deleteSession: vi.fn().mockResolvedValue(true),
    listSkills: vi.fn().mockResolvedValue({ skills: [] }),
    streamEvents: vi.fn(
      (
        _key: string,
        onEvent: (e: PiRuntimeEvent) => void,
        _onErr?: unknown,
        opts?: { live?: boolean; lastEventId?: string },
      ) => {
        // 订阅模式（对齐 resolveEventsSubscribeMode 语义）：
        //  - lastEventId=N ⇒ 重放 seq>N（同步 flush）+ live 增量；
        //  - 无 lastEventId + live ⇒ from=now（只收未来）。
        const hasCursor = typeof opts?.lastEventId === 'string'
        const after = hasCursor ? Number(opts!.lastEventId) : -1
        if (hasCursor) {
          for (const ev of buffer) {
            if ((ev.seq ?? -1) > after) onEvent(ev)
          }
        }
        const fn = (e: PiRuntimeEvent) => {
          onEvent(e)
        }
        live.add(fn)
        return () => {
          live.delete(fn)
        }
      },
    ),
  } as unknown as Record<string, Fn> & { buffer: PiRuntimeEvent[] }
}

function makeService(pi: unknown): AgentService {
  return new AgentService(
    {
      agentMessage: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
      agentThread: {
        findUnique: vi.fn().mockResolvedValue({ id: 't1' }),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      session: {
        findUnique: vi.fn().mockResolvedValue({ id: 's1', canvasData: null }),
        update: vi.fn(),
      },
      idempotencyRecord: {
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
    } as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn().mockResolvedValue(null) } as never,
  )
}

/** 给事件打 seq（pi-runtime 侧 buffer 语义）。⭐ startSeq 起连续编号——
 * pre 与 run 两段必须共用一个单调序列（重放过滤 seq>cursor 的语义前提）。 */
function withSeq(
  events: Array<ReturnType<typeof piEvent>>,
  startSeq = 0,
): PiRuntimeEvent[] {
  return events.map((e, i) => ({ ...e, seq: startSeq + i }) as PiRuntimeEvent)
}

describe('多端一致性 P1 · 双端一致性（同一 lane buffer 双订阅）', () => {
  const THREAD = 't1'
  let service: AgentService
  let pi: ReturnType<typeof makeLaneStub>

  beforeEach(() => {
    process.env.PI_RUNTIME_MODE = 'active'
    process.env.PI_RUNTIME_URL = 'http://127.0.0.1:8100'
  })
  afterEach(() => {
    delete process.env.PI_RUNTIME_MODE
    delete process.env.PI_RUNTIME_URL
    vi.restoreAllMocks()
  })

  function setup(pre: PiRuntimeEvent[], run: PiRuntimeEvent[]) {
    pi = makeLaneStub(pre, run)
    service = makeService(pi)
    ;(service as unknown as { createPiRuntimeClient: () => unknown }).createPiRuntimeClient =
      () => pi
    return pi
  }

  it('ack 锚点无漏无重：B 以 sinceSeq 订阅 ⇒ 恰好收到本 run 事件（不含 pre-run 重放）', async () => {
    // pre-run buffer：上一轮遗留（seq 0-2）；本轮 run：agent_start/文本×2/agent_end（seq 3-6）
    const pre = withSeq([
      piEvent('agent_end', { status: 'completed' }),
      piEvent('message_update', { event: { type: 'text_delta', delta: '旧' } }),
      piEvent('node_status', { nodeId: 'n1', status: 'done' }),
    ])
    const run = withSeq(
      [
        piEvent('agent_start', {}),
        piEvent('message_update', { event: { type: 'text_delta', delta: '你好' } }),
        piEvent('message_update', { event: { type: 'text_delta', delta: '，狐狸' } }),
        piEvent('agent_end', { status: 'completed' }),
      ],
      3, // ⭐ 单调连续：pre 占 0-2，run 从 3 起
    )
    setup(pre, run)

    // A 端：ack 架构发起（头探针读到 pre-run head=2 ⇒ sinceSeq=2）
    const ack = await service.startConversationRun('s1', '画狐狸', 'u1', THREAD)
    expect(ack.accepted).toBe(true)
    expect(ack.sinceSeq).toBe(2)

    // B 端：以 sinceSeq 订阅（重放已入 buffer 的 run 事件 + live 增量）
    const collected: Array<{ type: string; data: unknown }> = []
    void (async () => {
      for await (const ev of service.runEventStream(THREAD, {
        lastEventId: String(ack.sinceSeq),
      })) {
        collected.push(ev as unknown as { type: string; data: unknown })
      }
    })()

    // 等 run 收束（4 事件 × 15ms + 余量）
    await new Promise((r) => setTimeout(r, 200))
    const types = collected.map((e) => e.type)
    // 无漏：run 的映射事件全到（text_delta×2、done 收束）
    expect(types).toContain('text_delta')
    expect(types).toContain('done')
    // 无重放污染：pre-run 的 node_status 不允许出现
    expect(types).not.toContain('node_status')
    // 有序：文本增量按序拼接为原句（无重复刷屏）
    const text = collected
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.data as { text: string }).text)
      .join('')
    expect(text).toBe('你好，狐狸')
    expect(types.indexOf('done')).toBe(types.length - 1)
  })

  it('双订阅逐条相同：同游标的两个订阅者事件序列 type+data 一致（B2 晚挂靠重放补齐）', async () => {
    const pre = withSeq([piEvent('node_status', { nodeId: 'n0', status: 'done' })])
    const run = withSeq(
      [
        piEvent('agent_start', {}),
        piEvent('message_update', { event: { type: 'text_delta', delta: 'A' } }),
        piEvent('message_update', { event: { type: 'text_delta', delta: 'B' } }),
        piEvent('agent_end', { status: 'completed' }),
      ],
      1, // ⭐ pre 占 seq 0，run 从 1 起（单调连续）
    )
    setup(pre, run)
    const ack = await service.startConversationRun('s1', 'hi', 'u1', THREAD)

    const b1: Array<{ type: string; data: unknown }> = []
    void (async () => {
      for await (const ev of service.runEventStream(THREAD, {
        lastEventId: String(ack.sinceSeq),
      })) {
        b1.push(ev as unknown as { type: string; data: unknown })
      }
    })()
    // B2 晚挂（run 收束后才连）——纯重放补齐 ⇒ 与 B1（live 消费）逐条一致。
    // 性质：pi-runtime buffer 的重放序 == live 推送序（单调 seq 单一来源）。
    await new Promise((r) => setTimeout(r, 150))
    const b2: Array<{ type: string; data: unknown }> = []
    void (async () => {
      for await (const ev of service.runEventStream(THREAD, {
        lastEventId: String(ack.sinceSeq),
      })) {
        b2.push(ev as unknown as { type: string; data: unknown })
      }
    })()

    await new Promise((r) => setTimeout(r, 150))
    expect(b1.length).toBe(4)
    expect(b2.length).toBe(b1.length)
    expect(b2).toEqual(b1) // type+data（含 seq）逐条相等
  })

  it('A 端强断后 reconcile 非 missing：lane buffer 有 run 事件 ⇒ 流探测立即判 active', async () => {
    const pre = withSeq([piEvent('agent_end', { status: 'completed' })])
    const run = withSeq(
      [
        piEvent('agent_start', {}),
        piEvent('message_update', { event: { type: 'text_delta', delta: '长任务' } }),
        piEvent('agent_end', { status: 'completed' }),
      ],
      1, // ⭐ pre 占 seq 0，run 从 1 起（单调连续）
    )
    setup(pre, run)
    const ack = await service.startConversationRun('s1', 'hi', 'u1', THREAD)
    // 此刻 run 事件已开始入 buffer（drain 已触发 prompt）——模拟 A 端连接刚断
    await new Promise((r) => setTimeout(r, 30))
    const rt = await service.reconcileLatestAssistant(THREAD, ack.sinceSeq)
    expect(['active', 'settled']).toContain(rt.outcome) // ⛔ 绝不允许 missing（红车①）
  })
})
