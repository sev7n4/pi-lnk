import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import type { AgentStreamEvent } from '@lnkpi/agent'

/**
 * P1 Task 4（多端一致性 · 统一传输）：POST 仅回 ack，run 后台 drain。
 *
 * 被测对象：AgentService.startConversationRun + readLaneHeadSeq（私有，经行为观测）。
 * 测试策略：子类覆写 streamConversation（假生成器，记录消费轨迹）与
 * runEventStream（假事件流，模拟 lane buffer 重放），不触真 prisma / pi-runtime。
 *
 * 关键时序契约（plan Review Focus 3/5）：
 *  - ack 在**首个业务事件前**返回（非 fork 场景由头探针定游标）；
 *  - 头探针只读不触发（runEventStream lastEventId='0' 重放），head=buffer 最大 seq；
 *  - fork 场景 ack.threadId = fork 后新线程、sinceSeq=0（新 lane buffer 为空）；
 *  - 后台 drain 必须完整消费 generator（副作用=逐条到达），异常不得抛出。
 */

type DrainLog = string[]

class TestAgentService extends AgentService {
  public drainLog: DrainLog = []
  /** streamConversation 假实现：yield 前记录（模拟副作用），全部消费后写 'drained'。 */
  public fakeStream:
    | ((...args: unknown[]) => AsyncGenerator<AgentStreamEvent>)
    | null = null
  /** runEventStream 假实现：头探针消费的「buffer 重放」事件序列。 */
  public fakeBuffer: Array<{ seq?: number; type: string }> = []

  constructor() {
    super(
      {} as never, // prisma（被覆写路径不触）
      {} as never, // materialService
      {} as never, // providerResolver
    )
  }

  override streamConversation(...args: unknown[]): AsyncGenerator<AgentStreamEvent> {
    if (this.fakeStream) return this.fakeStream(...args)
    throw new Error('fakeStream not configured')
  }

  override runEventStream(
    _key: string,
    _opts?: { lastEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<AgentStreamEvent> {
    const buffer = this.fakeBuffer
    const signal = _opts?.signal
    async function* gen(): AsyncGenerator<AgentStreamEvent> {
      for (const ev of buffer) {
        if (signal?.aborted) return
        yield ev as AgentStreamEvent
      }
      // 重放完 buffer 后挂起（模拟 live 等待），直到 abort。
      await new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    return gen()
  }

  /** 记录型假 stream 工厂：事件逐条落 drainLog，最后写 'drained'。 */
  setRecordingStream(events: AgentStreamEvent[], gate?: Promise<void>): void {
    this.fakeStream = async function* (this: TestAgentService): AsyncGenerator<AgentStreamEvent> {
      this.drainLog.push('started')
      if (gate) await gate
      for (const ev of events) {
        this.drainLog.push(`ev:${ev.type}:${(ev as { seq?: number }).seq ?? '-'}`)
        yield ev
      }
      this.drainLog.push('drained')
    }.bind(this)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('AgentService.startConversationRun（P1 Task 4：POST 仅回 ack，run 后台 drain）', () => {
  let svc: TestAgentService

  beforeEach(() => {
    svc = new TestAgentService()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('非 fork：ack 在首个业务事件前返回，sinceSeq=头探针读到的 buffer head', async () => {
    // lane buffer 里已有历史事件（seq 到 9）；run 尚未开始（gate 未放行）。
    svc.fakeBuffer = [
      { seq: 3, type: 'text_delta' },
      { seq: 5, type: 'tool_call' },
      { seq: 9, type: 'agent_end' },
    ]
    const gate = new Promise<void>(() => {}) // 永不放行：首个 yield 前挂起
    svc.setRecordingStream([{ type: 'done', data: {} }], gate)

    const ackPromise = svc.startConversationRun('sess-1', '你好', 'user-1', 'thread-1')
    // ack 不应等 gate：探针静默窗 150ms + 若干拍内必 resolve（gate 永不放行 ⇒
    // 若 ack 在等首个业务事件，这里必然超时为 null）
    const ack = await Promise.race([ackPromise, sleep(400).then(() => null)])
    expect(ack).not.toBeNull()
    expect(ack!.accepted).toBe(true)
    expect(ack!.threadId).toBe('thread-1')
    expect(ack!.sinceSeq).toBe(9)
    // 头探针必须是「重放读」而非触发：runEventStream 收到 lastEventId='0'
    // —— 但探针已换成假实现，语义由 fakeBuffer 消费体现（上面 sinceSeq=9 即证）。
  })

  it('后台 drain 完整消费 generator（副作用保留，plan Review Focus 5）', async () => {
    svc.fakeBuffer = []
    svc.setRecordingStream([
      { type: 'text_delta', data: { text: 'a' }, seq: 10 } as AgentStreamEvent,
      { type: 'text_delta', data: { text: 'b' }, seq: 11 } as AgentStreamEvent,
      { type: 'done', data: {} } as AgentStreamEvent,
    ])

    const ack = await svc.startConversationRun('sess-1', '画一只狐狸', 'user-1')
    expect(ack.accepted).toBe(true)
    // 等 drain 跑完（微任务+若干拍）
    await sleep(30)
    expect(svc.drainLog).toEqual([
      'started',
      'ev:text_delta:10',
      'ev:text_delta:11',
      'ev:done:-',
      'drained',
    ])
  })

  it('fork 场景（branchFromEntryId）：ack.threadId=fork 后新线程，sinceSeq=0（新 lane 空 buffer）', async () => {
    svc.fakeBuffer = [{ seq: 7, type: 'agent_end' }] // 旧线程 buffer 有历史，但 fork 场景不探它
    svc.setRecordingStream([
      {
        type: 'thread_forked',
        data: { threadId: 'fork-new-1', newSessionId: 'sess-9' },
      } as AgentStreamEvent,
      { type: 'text_delta', data: { text: 'x' }, seq: 0 } as AgentStreamEvent,
      { type: 'done', data: {} } as AgentStreamEvent,
    ])

    const ack = await svc.startConversationRun(
      'sess-1',
      '重跑这条',
      'user-1',
      'thread-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'entry-42', // branchFromEntryId ⇒ fork
    )
    expect(ack.accepted).toBe(true)
    expect(ack.threadId).toBe('fork-new-1')
    expect(ack.forkedThreadId).toBe('fork-new-1')
    expect(ack.sinceSeq).toBe(0)
    await sleep(20)
    expect(svc.drainLog[0]).toBe('started')
  })

  it('drain 中途抛错：不影响已返回的 ack，异常只记日志不向上抛', async () => {
    svc.fakeBuffer = []
    svc.fakeStream = async function* (): AsyncGenerator<AgentStreamEvent> {
      yield { type: 'text_delta', data: { text: 'a' }, seq: 1 } as AgentStreamEvent
      throw new Error('pi-runtime exploded')
    }
    const ack = await svc.startConversationRun('sess-1', 'hi', 'user-1')
    expect(ack.accepted).toBe(true)
    await sleep(20) // 让 drain 的 rejection 落地——若向上抛，unhandledRejection 会让 vitest 红
  })

  it('fork 请求但 fork 失败（thread_forked 未出现流即结束）：ack 兜底回旧线程', async () => {
    svc.setRecordingStream([
      { type: 'error', data: { message: 'fork failed', error_type: 'fork_failed' } } as AgentStreamEvent,
      { type: 'done', data: {} } as AgentStreamEvent,
    ])
    const ack = await svc.startConversationRun(
      'sess-1',
      '重跑这条',
      'user-1',
      'thread-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'entry-42',
    )
    expect(ack.accepted).toBe(true)
    expect(ack.threadId).toBe('thread-1') // 兜底：旧线程
    expect(ack.sinceSeq).toBe(0) // 未探针（fork 场景跳过头探针）
  })
})

describe('AgentService.startConversationRun 头探针（readLaneHeadSeq 行为面）', () => {
  it('空 buffer（404/lane 未驻留 ⇒ fakeBuffer 空）⇒ sinceSeq=0（全量重放+前端边界去重的退化路径）', async () => {
    const svc = new TestAgentService()
    svc.fakeBuffer = []
    svc.setRecordingStream([{ type: 'done', data: {} } as AgentStreamEvent])
    const ack = await svc.startConversationRun('sess-1', '第一条', 'user-1')
    expect(ack.sinceSeq).toBe(0)
  })

  it('无 seq 的合成事件（credit_tx 等）不参与 head 计算', async () => {
    const svc = new TestAgentService()
    svc.fakeBuffer = [
      { type: 'credit_tx' },
      { seq: 4, type: 'text_delta' },
      { type: 'credit_tx' },
    ]
    svc.setRecordingStream([{ type: 'done', data: {} } as AgentStreamEvent])
    const ack = await svc.startConversationRun('sess-1', 'hi', 'user-1')
    expect(ack.sinceSeq).toBe(4)
  })
})
