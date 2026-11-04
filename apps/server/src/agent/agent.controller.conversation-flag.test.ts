/**
 * 多端一致性 P1（计划 2026-11-04 Task 4）：POST /chat/conversation 的 flag 分支。
 *
 * `STREAM_MAIN_FROM_PIRUNTIME=on` ⇒ 返回 JSON ack（{code:0,data:{accepted,threadId,sinceSeq}}），
 * run 交 `startConversationRun` 后台执行；`off`（默认）⇒ 既有 SSE 响应体流逐字节不变
 * （含 `data: [DONE]` 终止哨兵）——兼容回滚的回归判据（Review Focus 1）。
 *
 * 前置守卫（幂等缓存 / 意图去重 / 会话鉴权）**两模式共用**且保持 SSE 形态：
 * 前端按响应 Content-Type 分派（application/json ⇒ ack 路径）。
 */
import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  return {
    headers: {} as Record<string, string>,
    user: { sub: 'U1' },
  }
}

function makeController(overrides: Partial<Record<string, unknown>> = {}) {
  const agentService = {
    checkIdempotencyKey: vi.fn().mockResolvedValue(null),
    findDuplicateIntent: vi.fn().mockResolvedValue(null),
    startConversationRun: vi
      .fn()
      .mockResolvedValue({ accepted: true, threadId: 'T1', sinceSeq: 7 }),
    streamConversation: vi.fn(async function* () {
      yield { type: 'text_delta', data: { text: 'hi' } }
    }),
    ...overrides,
  }
  const sessionsService = { findOne: vi.fn().mockResolvedValue({ id: 'S1' }) }
  const controller = new AgentController(
    agentService as never,
    sessionsService as never,
    {} as never,
    {} as never,
  )
  return { controller, agentService, sessionsService }
}

const DTO = {
  sessionId: 'S1',
  message: '画一只红车',
  threadId: 'T1',
}

beforeEach(() => {
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /chat/conversation 的 STREAM_MAIN_FROM_PIRUNTIME 分支', () => {
  it('flag on ⇒ JSON ack（run 交后台 drain，不写 SSE 帧、不写 [DONE]）', async () => {
    vi.stubEnv('STREAM_MAIN_FROM_PIRUNTIME', 'on')
    const { controller, agentService } = makeController()
    const res = makeRes()

    await controller.conversation(DTO as never, makeReq() as never, res as never)

    expect(agentService.startConversationRun).toHaveBeenCalledTimes(1)
    const args = agentService.startConversationRun.mock.calls[0][0] as Record<string, unknown>
    expect(args).toMatchObject({ sessionId: 'S1', message: '画一只红车', userId: 'U1', threadId: 'T1' })
    expect(res.json).toHaveBeenCalledWith({
      code: 0,
      message: 'ok',
      data: { accepted: true, threadId: 'T1', sinceSeq: 7 },
    })
    expect(res.write).not.toHaveBeenCalled() // 不再经响应体发事件帧
    expect(res.end).not.toHaveBeenCalled()
    expect(agentService.streamConversation).not.toHaveBeenCalled() // controller 不再直连 generator
  })

  it('flag off（缺省）⇒ 既有 SSE 流不变：事件帧 + [DONE] 哨兵 + end', async () => {
    const { controller, agentService } = makeController()
    const res = makeRes()

    await controller.conversation(DTO as never, makeReq() as never, res as never)

    expect(agentService.startConversationRun).not.toHaveBeenCalled()
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream')
    const writes = res.write.mock.calls.map((c) => c[0] as string)
    expect(writes).toContain('data: {"type":"text_delta","data":{"text":"hi"}}\n\n')
    expect(writes).toContain('data: [DONE]\n\n')
    expect(res.end).toHaveBeenCalled()
  })

  it('flag off 但显式置 off 值 ⇒ 同样走 SSE（显式配置与缺省一致）', async () => {
    vi.stubEnv('STREAM_MAIN_FROM_PIRUNTIME', 'off')
    const { controller } = makeController()
    const res = makeRes()

    await controller.conversation(DTO as never, makeReq() as never, res as never)

    expect(res.write).toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it('flag on：startConversationRun 抛错 ⇒ 500 语义上抛（不静默吞）', async () => {
    vi.stubEnv('STREAM_MAIN_FROM_PIRUNTIME', 'on')
    const { controller } = makeController({
      startConversationRun: vi.fn().mockRejectedValue(new Error('db down')),
    })
    const res = makeRes()

    await expect(
      controller.conversation(DTO as never, makeReq() as never, res as never),
    ).rejects.toThrow('db down')
    expect(res.json).not.toHaveBeenCalled()
  })

  // T8 canary（2026-11-04 生产实证）：方法开头为 SSE 路径预设了
  // text/event-stream，而 Express 4 的 res.json() **不覆盖**已存在的
  // Content-Type ⇒ ack 响应带着 SSE 头出去 ⇒ 前端
  // isConversationAckResponse()（判据=ct.includes('application/json')）判
  // false ⇒ 分派失效：ack body 被当 SSE 逐行 split，全部不匹配 `data: `
  // 前缀而静默丢弃。⇒ flag 分支必须**显式覆盖** Content-Type。
  it('flag on ⇒ ack 响应必须显式覆盖 Content-Type 为 application/json', async () => {
    vi.stubEnv('STREAM_MAIN_FROM_PIRUNTIME', 'on')
    const { controller, agentService } = makeController()
    const res = makeRes()

    await controller.conversation(DTO as never, makeReq() as never, res as never)

    // 方法开头已设 SSE 头（模拟真实 Express 行为：头已存在）
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream')
    // flag 分支必须再显式覆盖为 JSON——这是前端分派的唯一判据
    const setCalls = res.setHeader.mock.calls as Array<[string, string]>
    const jsonHeader = setCalls.find(
      ([k, v]) => k === 'Content-Type' && v.includes('application/json'),
    )
    expect(jsonHeader).toBeDefined()
    expect(agentService.startConversationRun).toHaveBeenCalledTimes(1)
  })
})
