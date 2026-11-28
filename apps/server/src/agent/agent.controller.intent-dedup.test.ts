/**
 * 2026-11-28 意图去重误杀修复：命中时按真实状态说话，不编造「已为你复用」。
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentController } from './agent.controller'

function makeRes() {
  const res = {
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  }
  res.status.mockReturnThis()
  return res
}

function makeReq() {
  return { headers: {} as Record<string, string>, user: { sub: 'U1' } }
}

function frames(res: ReturnType<typeof makeRes>): Array<{ type: string; data?: unknown }> {
  return res.write.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; data?: unknown })
}

function makeController(hit: unknown) {
  const agentService = {
    checkIdempotencyKey: vi.fn().mockResolvedValue(null),
    findDuplicateIntent: vi.fn().mockResolvedValue(Boolean(hit)),
    getDuplicateIntent: vi.fn().mockResolvedValue(hit),
    startConversationRun: vi
      .fn()
      .mockResolvedValue({ accepted: true, threadId: 'T1', sinceSeq: 7 }),
    streamConversation: vi.fn(async function* () {
      yield { type: 'text_delta', data: { text: 'hi' } }
    }),
  }
  const sessionsService = { findOne: vi.fn().mockResolvedValue({ id: 'S1' }) }
  const controller = new AgentController(
    agentService as never,
    sessionsService as never,
    {} as never,
    {} as never,
  )
  return { controller, agentService }
}

const BASE = { sessionId: 'S1', threadId: 'T1', message: '画一只红车' } as never

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('STREAM_MAIN_FROM_PIRUNTIME', 'on')
})

describe('意图去重命中：结构化原因 + 真实文案', () => {
  it('processing：只说仍在处理中，不下发可复用断言', async () => {
    const { controller } = makeController({
      status: 'processing',
      resultSummary: null,
      createdAt: new Date('2026-11-28T10:41:59.000Z'),
    })
    const res = makeRes()

    await controller.conversation(BASE, makeReq() as never, res as never)

    const out = frames(res)
    expect(out[0]).toMatchObject({
      type: 'turn_not_submitted',
      data: { reason: 'duplicate_intent', detail: { status: 'processing' } },
    })
    const text = String((out[1].data as { text: string }).text)
    expect(text).toContain('仍在处理中')
    expect(text).not.toContain('已为你复用')
  })

  it('completed 且有摘要：陈述刚已完成与真实摘要', async () => {
    const { controller } = makeController({
      status: 'completed',
      resultSummary: '已生成红色小汽车',
      createdAt: new Date('2026-11-28T10:41:59.000Z'),
    })
    const res = makeRes()

    await controller.conversation(BASE, makeReq() as never, res as never)

    const out = frames(res)
    expect(out[0].data).toMatchObject({
      reason: 'duplicate_intent',
      detail: { status: 'completed', hasResult: true },
    })
    const text = String((out[1].data as { text: string }).text)
    expect(text).toContain('已生成红色小汽车')
    expect(text).not.toContain('已为你复用')
  })

  it('completed 无摘要：如实说明无可复用结果并给出强制重发出口', async () => {
    const { controller } = makeController({
      status: 'completed',
      resultSummary: null,
      createdAt: new Date('2026-11-28T10:41:59.000Z'),
    })
    const res = makeRes()

    await controller.conversation(BASE, makeReq() as never, res as never)

    const text = String((frames(res)[1].data as { text: string }).text)
    expect(text).toContain('未找到可复用结果')
    expect(text).toContain('仍要发送')
    expect(text).not.toContain('已为你复用')
  })

  it('force=true：跳过去重门，run 正常发起', async () => {
    const { controller, agentService } = makeController({
      status: 'completed',
      resultSummary: '旧结果',
      createdAt: new Date(),
    })
    const res = makeRes()

    await controller.conversation({ ...BASE, force: true } as never, makeReq() as never, res as never)

    expect(agentService.getDuplicateIntent).not.toHaveBeenCalled()
    expect(agentService.startConversationRun).toHaveBeenCalledTimes(1)
  })

  it('控制语句「继续推进」不查去重门（即使旧指纹存在）', async () => {
    const { controller, agentService } = makeController({
      status: 'completed',
      resultSummary: '旧结果',
      createdAt: new Date(),
    })
    const res = makeRes()

    await controller.conversation(
      { ...BASE, message: '继续推进' } as never,
      makeReq() as never,
      res as never,
    )

    expect(agentService.getDuplicateIntent).not.toHaveBeenCalled()
    expect(agentService.startConversationRun).toHaveBeenCalledTimes(1)
  })
})
