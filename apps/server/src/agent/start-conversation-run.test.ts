/**
 * 多端一致性 P1（规格 2026-10-21 §10 / 计划 2026-11-04 Task 4）：
 * `startConversationRun` —— flag `STREAM_MAIN_FROM_PIRUNTIME=on` 时，POST
 * /chat/conversation 仅回 JSON ack，run 由服务端后台 drain（全部既有副作用保留）。
 *
 * 契约（计划 Task 4 Interfaces）：
 *   ack = { accepted: true, threadId, sinceSeq }        —— sinceSeq = 触发时刻 lane head
 *   fork 场景（branchFromEntryId）：threadId = fork 后新线程 id（首个事件 thread_forked）
 *   fork 失败：{ accepted: false, errorMessage }
 *   ⭐ runEventStream/POST 体消费的同一份 lane buffer ⇒ 订阅 sinceSeq 无漏事件。
 *
 * ⭐ 计划要点：startConversationRun 以**末尾追加参数**方式调 streamConversation
 *   （中段插参会移位 ~40 处按位置调用的测试 —— spec §11 风险），此处用 spy 断言实参序列。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { AgentService } from './agent.service'
import { PiRuntimeError } from './pi-runtime/pi-runtime.client'

function makeService(): AgentService {
  const service = new AgentService(
    {} as unknown as never,
    { createFromAgent: vi.fn() } as unknown as never,
    { resolveForGeneration: vi.fn() } as unknown as never,
  )
  return service
}

/** stub 私有 getPiRuntimeUrl/createPiRuntimeClient：headSeq 数据源。 */
function stubSnapshot(
  service: AgentService,
  headByThread: Record<string, number>,
  order?: string[],
) {
  const s = service as unknown as Record<string, ReturnType<typeof vi.fn>>
  s.getPiRuntimeUrl = vi.fn().mockReturnValue('http://pi-runtime')
  s.createPiRuntimeClient = vi.fn().mockReturnValue({
    snapshot: vi.fn().mockImplementation(async (key: string) => {
      order?.push(`snapshot:${key}`)
      if (!(key in headByThread)) throw new Error('snapshot: session not found (404)')
      return { lane: key, transcriptTail: [{ seq: headByThread[key] }] }
    }),
  })
}

interface GenStub {
  yields: Array<Record<string, unknown>>
  /** 首个 yield 前的挂起（模拟 fork/LLM 首包延迟），可注入以测 ack 超时。 */
  hangBeforeFirstMs?: number
  /** 事件间隔（模拟 run 推进慢于 ack 返回）。 */
  intervalMs?: number
}

/** stub streamConversation：记录消费次序与实参序列，drain 完成后 resolve。 */
function stubStream(service: AgentService, stub: GenStub, order?: string[]) {
  const consumed: Array<Record<string, unknown>> = []
  let finishDrain: (() => void) | null = null
  const drained = new Promise<void>((r) => {
    finishDrain = r
  })
  const spy = vi
    .spyOn(service, 'streamConversation')
    .mockImplementation(async function* (
      this: unknown,
      ...args: unknown[]
    ): AsyncGenerator<never> {
      order?.push('gen-start')
      // 记录实参序列：末尾追加参数不移位的回归判据（计划 ⭐）
      ;(spy as unknown as { positionalArgs: unknown[] }).positionalArgs = args
      if (stub.hangBeforeFirstMs) await new Promise((r) => setTimeout(r, stub.hangBeforeFirstMs))
      for (const ev of stub.yields) {
        consumed.push(ev)
        yield ev as never
        if (stub.intervalMs) await new Promise((r) => setTimeout(r, stub.intervalMs))
      }
      finishDrain?.()
    } as never)
  return { spy, consumed, drained, spyWithArgs: spy as unknown as { positionalArgs: unknown[] } }
}

const ARGS = {
  sessionId: 'S1',
  message: '画一只红车',
  userId: 'U1',
  threadId: 'T1',
} as const

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('startConversationRun（P1 Task 4：ack 化 + 后台 drain）', () => {
  it('正常路径：ack 带触发时刻 lane head（sinceSeq=7），且 snapshot 先于 drain 消费', async () => {
    const service = makeService()
    const order: string[] = []
    stubSnapshot(service, { T1: 7 }, order)
    const { drained } = stubStream(service, { yields: [{ type: 'turn_started' }] }, order)

    const ack = await service.startConversationRun(ARGS)

    expect(ack).toEqual({ accepted: true, threadId: 'T1', sinceSeq: 7 })
    // ⭐ 顺序不变量：游标锚点必须取自 run 启动**前**的 head，
    //    否则 run 的前几帧会被 ack 游标跳过（漏窗 = M3 主诉）。
    expect(order.indexOf('snapshot:T1')).toBeLessThan(order.indexOf('gen-start'))
    // drain 是后台的：ack 返回时可能尚未消费完 ⇒ 等 drain 收尾再断言副作用保留
    await drained
  })

  it('drain 完整消费 generator（ack 后所有事件仍被逐个拉取 —— 副作用保留）', async () => {
    const service = makeService()
    stubSnapshot(service, { T1: 0 })
    const { consumed, drained } = stubStream(service, {
      yields: [
        { type: 'turn_started' },
        { type: 'text_delta', data: { text: 'a' } },
        { type: 'done' },
      ],
    })

    await service.startConversationRun(ARGS)
    // ⭐ 顺序不变量「snapshot 先于 gen-start」已由上一用例钉死；本用例只证副作用完整：
    //    drain 是后台的，ack 返回时可能已消费 0..N 条 ⇒ 等 drain 收尾再断言全量。
    await drained
    expect(consumed.map((e) => e.type)).toEqual(['turn_started', 'text_delta', 'done'])
  })

  it('pi-runtime 不可达（getPiRuntimeUrl=null）⇒ sinceSeq 省略（null ⇒ 前端 from=now，不重放历史）', async () => {
    const service = makeService()
    const s = service as unknown as Record<string, ReturnType<typeof vi.fn>>
    s.getPiRuntimeUrl = vi.fn().mockReturnValue(null)
    const { drained } = stubStream(service, { yields: [] })

    const ack = await service.startConversationRun(ARGS)
    expect(ack.accepted).toBe(true)
    expect(ack.sinceSeq).toBeUndefined()
    await drained
  })

  it('snapshot 404（新线程无 lane）⇒ sinceSeq=0（lane 为空，重放无害且不漏帧）', async () => {
    const service = makeService()
    stubSnapshot(service, { __none__: -1 }) // 空 map ⇒ 一律 404
    // 覆写为真 404（PiRuntimeError.status===404 才判「新线程」）
    const s = service as unknown as Record<string, ReturnType<typeof vi.fn>>
    s.createPiRuntimeClient = vi.fn().mockReturnValue({
      snapshot: vi.fn().mockRejectedValue(new PiRuntimeError('snapshot: session not found', 404)),
    })
    const { drained } = stubStream(service, { yields: [] })

    const ack = await service.startConversationRun(ARGS)
    expect(ack).toEqual({ accepted: true, threadId: 'T1', sinceSeq: 0 })
    await drained
  })

  it('snapshot 未知错误（网络抖动，非 404）⇒ sinceSeq 省略（宁失早帧不重放历史）', async () => {
    const service = makeService()
    const s = service as unknown as Record<string, ReturnType<typeof vi.fn>>
    s.getPiRuntimeUrl = vi.fn().mockReturnValue('http://pi-runtime')
    s.createPiRuntimeClient = vi.fn().mockReturnValue({
      snapshot: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    })
    const { drained } = stubStream(service, { yields: [] })

    const ack = await service.startConversationRun(ARGS)
    expect(ack.accepted).toBe(true)
    expect(ack.sinceSeq).toBeUndefined()
    await drained
  })

  it('参数以末尾追加方式透传 streamConversation（位置不移位）', async () => {
    const service = makeService()
    stubSnapshot(service, { T1: 3 })
    const { spyWithArgs, drained } = stubStream(service, { yields: [] })

    await service.startConversationRun({ ...ARGS, selectedNodeIds: ['n1'] })
    expect(spyWithArgs.positionalArgs[0]).toBe('S1')
    expect(spyWithArgs.positionalArgs[1]).toBe('画一只红车')
    expect(spyWithArgs.positionalArgs[2]).toBe('U1')
    expect(spyWithArgs.positionalArgs[3]).toBe('T1')
    // 15 个位置参数的末位 = selectedNodeIds；billingSource 不传（缺省 user）
    expect(spyWithArgs.positionalArgs).toHaveLength(15)
    expect(spyWithArgs.positionalArgs[14]).toEqual(['n1'])
    await drained
  })

  describe('fork 场景（branchFromEntryId）', () => {
    it('首个事件 thread_forked ⇒ ack 用新线程 id + 新线程 head 游标', async () => {
      const service = makeService()
      const order: string[] = []
      stubSnapshot(service, { T1: 5, T2: 9 }, order)
      const { drained } = stubStream(service, {
        yields: [
          { type: 'thread_forked', data: { threadId: 'T2' } },
          { type: 'turn_started' },
        ],
      })

      const ack = await service.startConversationRun({ ...ARGS, branchFromEntryId: 'e1' })

      expect(ack).toEqual({ accepted: true, threadId: 'T2', sinceSeq: 9 })
      expect(order).toContain('snapshot:T2')
      await drained
    })

    it('首个事件 error（fork 失败）⇒ accepted:false + errorMessage，drain 仍清空', async () => {
      const service = makeService()
      stubSnapshot(service, { T1: 5 })
      const { consumed, drained } = stubStream(service, {
        yields: [
          { type: 'error', data: { message: '重跑失败：目标消息已不存在', error_type: 'fork_failed' } },
          { type: 'done', data: {} },
        ],
      })

      const ack = await service.startConversationRun({ ...ARGS, branchFromEntryId: 'e1' })

      expect(ack.accepted).toBe(false)
      expect(ack.errorMessage).toBe('重跑失败：目标消息已不存在')
      await drained
      expect(consumed.map((e) => e.type)).toEqual(['error', 'done'])
    })

    it('首个事件迟迟不来（>forkAckTimeoutMs）⇒ 按原线程 ack，不无限挂起', async () => {
      const service = makeService()
      stubSnapshot(service, { T1: 5 })
      const { drained } = stubStream(service, {
        yields: [{ type: 'turn_started' }],
        hangBeforeFirstMs: 500,
      })

      const ack = await service.startConversationRun({ ...ARGS, branchFromEntryId: 'e1', forkAckTimeoutMs: 50 })
      expect(ack).toEqual({ accepted: true, threadId: 'T1', sinceSeq: 5 })
      await drained
    })
  })

  it('drain 内 generator 抛错不冒泡到 ack（后台静默记日志）', async () => {
    const service = makeService()
    stubSnapshot(service, { T1: 1 })
    vi.spyOn(service, 'streamConversation').mockImplementation(async function* () {
      yield { type: 'turn_started' } as never
      throw new Error('mid-run boom')
    } as never)

    const ack = await service.startConversationRun(ARGS)
    expect(ack.accepted).toBe(true)
    // 让后台 drain 的 rejection 有机会冒出来（未捕获 ⇒ vitest 会挂）
    await new Promise((r) => setTimeout(r, 20))
  })
})
