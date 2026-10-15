import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GenerationRecoveryService } from './generation-recovery.service'
import { __resetPresenceForTest, recordSessionSeen } from './presence'

function makeAgent(over: Partial<Record<string, unknown>> = {}) {
  return {
    followUpPiRun: vi.fn(async () => ({ queued: true })),
    streamConversation: vi.fn(async function* () {
      yield { type: 'text_delta', data: { text: 'ok' } }
    }),
    ...over,
  } as never
}

const failInput = {
  sessionId: 'sess-1',
  threadId: 'thread-1',
  userId: 'user-1',
  nodeId: 'node-1',
  nodeTitle: '大灰狼视频',
  generationRecordId: 'rec-1',
  errorCode: 'upstream_timeout',
  userMessage: '上游超时',
  refundedPoints: 5,
}

describe('GenerationRecoveryService.handleGenerationFailed', () => {
  beforeEach(() => {
    __resetPresenceForTest()
    process.env.GENERATION_RECOVERY_ENABLED = 'true'
  })

  it('空闲在线 → 走 newTurn（streamConversation drain），消息含结构化字段', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    const d = await svc.handleGenerationFailed(failInput)
    expect(d.path).toBe('newTurn')
    const calls = (agent as never as { streamConversation: { mock: { calls: unknown[][] } } })
      .streamConversation.mock.calls
    expect(calls.length).toBe(1)
    // 位置参数签名：streamConversation(sessionId, message, userId, threadId)（agent.service.ts:222）
    expect(calls[0][0]).toBe('sess-1')
    const message = calls[0][1] as string
    expect(message).toContain('rec-1')
    expect(message).toContain('upstream_timeout')
    expect(message).toContain('已退回 5 积分')
    expect(calls[0][2]).toBe('user-1')
  })

  it('drain 回注 run 传 billingSource=automation（终审 I-2：预扣失败降级照常执行，不被 402 静默吞）', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    await svc.handleGenerationFailed(failInput)
    const calls = (agent as never as { streamConversation: { mock: { calls: unknown[][] } } })
      .streamConversation.mock.calls
    expect(calls.length).toBe(1)
    // billingSource 落在末位（第 16 个位置参数）——回注 run = automation 触发
    expect(calls[0][15]).toBe('automation')
  })

  it('活跃 run → 走 followUp，且不碰 streamConversation', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    const d = await svc.handleGenerationFailed({ ...failInput, hasActiveRun: true })
    expect(d.path).toBe('followUp')
    expect(
      (agent as never as { followUpPiRun: { mock: { calls: unknown[][] } } }).followUpPiRun.mock
        .calls.length,
    ).toBe(1)
    expect(
      (agent as never as { streamConversation: { mock: { calls: unknown[][] } } }).streamConversation
        .mock.calls.length,
    ).toBe(0)
  })

  it('同 record 二次调用 → skip 且不重复派发（幂等，poll+catch 双发射防护）', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    await svc.handleGenerationFailed(failInput)
    const d2 = await svc.handleGenerationFailed(failInput)
    expect(d2.path).toBe('skip')
    expect(d2.reason).toBe('record-already-dispatched')
    expect(
      (agent as never as { streamConversation: { mock: { calls: unknown[][] } } }).streamConversation
        .mock.calls.length,
    ).toBe(1)
  })

  it('离线 → skip 且零派发', async () => {
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    const d = await svc.handleGenerationFailed(failInput)
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('user-offline')
    expect(
      (agent as never as { followUpPiRun: { mock: { calls: unknown[][] } } }).followUpPiRun.mock
        .calls.length,
    ).toBe(0)
  })

  it('同因连败第 2 次 → briefOnly（消息为一句简报）', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    await svc.handleGenerationFailed(failInput)
    await svc.handleGenerationFailed({ ...failInput, generationRecordId: 'rec-2', hasActiveRun: true })
    const followCalls = (
      agent as never as { followUpPiRun: { mock: { calls: unknown[][] } } }
    ).followUpPiRun.mock.calls
    expect(followCalls.length).toBe(1)
    const text = (followCalls[0][0] as Record<string, string>).text
    expect(text).toContain('一句话')
    expect(text).not.toContain('下一步选项')
  })

  it('消息文案禁自动 run_*（gate 兜底外的文案防线）', async () => {
    recordSessionSeen('thread-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    await svc.handleGenerationFailed(failInput)
    const message = (
      agent as never as { streamConversation: { mock: { calls: unknown[][] } } }
    ).streamConversation.mock.calls[0][1] as string
    expect(message).toContain('不要')
    expect(message).toContain('run_')
  })

  it('flag off（默认）→ skip 且零派发（逐字节旧行为）', async () => {
    delete process.env.GENERATION_RECOVERY_ENABLED
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    recordSessionSeen('thread-1')
    const d = await svc.handleGenerationFailed(failInput)
    expect(d.path).toBe('skip')
    expect(d.reason).toBe('flag-off')
    expect(
      (agent as never as { streamConversation: { mock: { calls: unknown[][] } } }).streamConversation
        .mock.calls.length,
    ).toBe(0)
  })

  it('threadId 缺省 → presence 按 sessionId 判定（发射点无 threadId 的生产路径）', async () => {
    recordSessionSeen('sess-1')
    const agent = makeAgent()
    const svc = new GenerationRecoveryService(agent as never)
    const d = await svc.handleGenerationFailed({ ...failInput, threadId: null })
    expect(d.path).toBe('newTurn')
  })
})
