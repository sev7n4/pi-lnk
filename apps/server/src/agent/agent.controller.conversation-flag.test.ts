import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import { AgentController } from './agent.controller'
import { isStreamMainFromPiRuntimeEnabled } from './stream-main-flag'

/**
 * P1 Task 4（多端一致性 · 统一传输）：POST /chat/conversation flag 双分支。
 *
 *  - off（默认）：响应体流 SSE + `[DONE]`，**行为逐字节不变**（plan Review Focus 1）；
 *  - on：JSON ack（startConversationRun），不设 SSE 头、不写流。
 *
 * res 用记录型假对象（与既有 controller 测试同策略），service 全 fake。
 */

type FakeRes = {
  headers: Record<string, string>
  writes: string[]
  jsonBody: unknown
  statusCode: number | undefined
  setHeader: (k: string, v: string) => void
  write: (s: string) => void
  end: () => void
  status: (code: number) => FakeRes
  json: (body: unknown) => FakeRes
}

function makeFakeRes(): FakeRes & Response {
  const res: FakeRes = {
    headers: {},
    writes: [],
    jsonBody: undefined,
    statusCode: undefined,
    setHeader(k, v) {
      res.headers[k] = v
    },
    write(s) {
      res.writes.push(s)
    },
    end() {},
    status(code) {
      res.statusCode = code
      return res as unknown as FakeRes
    },
    json(body) {
      res.jsonBody = body
      return res as unknown as FakeRes
    },
  }
  return res as unknown as FakeRes & Response
}

function makeController(overrides: {
  stream?: () => AsyncGenerator<unknown>
  startRun?: (...args: unknown[]) => Promise<unknown>
  checkIdempotency?: (key: string) => Promise<unknown>
  findDuplicateIntent?: (...args: unknown[]) => Promise<unknown>
}): AgentController {
  const svc = {
    streamConversation: overrides.stream ?? (async function* () {}),
    startConversationRun:
      overrides.startRun ??
      (async () => ({ accepted: true, threadId: 't', sinceSeq: 0 })),
    checkIdempotencyKey: overrides.checkIdempotency ?? (async () => null),
    findDuplicateIntent: overrides.findDuplicateIntent ?? (async () => null),
    getCapabilities: () => ({}),
  }
  const sessions = { findOne: async () => ({}) }
  return new AgentController(
    svc as never,
    sessions as never,
    {} as never, // canvasTools（本端点不触）
    {} as never, // memory
  )
}

const baseDto = {
  sessionId: 'sess-1',
  message: '画一只狐狸',
  threadId: 'thread-1',
}

describe('POST /chat/conversation · STREAM_MAIN_FROM_PIRUNTIME flag 双分支（P1 Task 4）', () => {
  const ENV_KEY = 'STREAM_MAIN_FROM_PIRUNTIME'
  let original: string | undefined

  beforeEach(() => {
    original = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
  })
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = original
    vi.restoreAllMocks()
  })

  it('flag 判定：未设置/off ⇒ false；on/true/1 ⇒ true（默认 off，灰度回滚=改 env）', () => {
    delete process.env[ENV_KEY]
    expect(isStreamMainFromPiRuntimeEnabled()).toBe(false)
    process.env[ENV_KEY] = 'off'
    expect(isStreamMainFromPiRuntimeEnabled()).toBe(false)
    process.env[ENV_KEY] = 'on'
    expect(isStreamMainFromPiRuntimeEnabled()).toBe(true)
    process.env[ENV_KEY] = 'true'
    expect(isStreamMainFromPiRuntimeEnabled()).toBe(true)
    process.env[ENV_KEY] = '1'
    expect(isStreamMainFromPiRuntimeEnabled()).toBe(true)
  })

  it('off：SSE 流式路径逐字节不变——SSE 头 + data 帧 + [DONE]，不调 startConversationRun', async () => {
    const startRun = vi.fn()
    const ctrl = makeController({
      stream: async function* () {
        yield { type: 'text_delta', data: { text: '你好' } }
        yield { type: 'done', data: {} }
      },
      startRun,
    })
    const res = makeFakeRes()
    await ctrl.conversation(baseDto, { user: { sub: 'u1' }, headers: {} } as never, res)

    expect(res.headers['Content-Type']).toBe('text/event-stream')
    expect(res.writes).toEqual([
      `data: ${JSON.stringify({ type: 'text_delta', data: { text: '你好' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', data: {} })}\n\n`,
      'data: [DONE]\n\n',
    ])
    expect(startRun).not.toHaveBeenCalled()
  })

  it('on：JSON ack——不设 SSE 头、startConversationRun 以与 streamConversation 相同的位置参数被调', async () => {
    process.env[ENV_KEY] = 'on'
    const startRun = vi.fn(async () => ({
      accepted: true,
      threadId: 'thread-1',
      sinceSeq: 9,
    }))
    const stream = vi.fn()
    const ctrl = makeController({ startRun, stream })
    const res = makeFakeRes()
    const dto = {
      ...baseDto,
      skillId: 'sk-1',
      model: 'm-1',
      thinking: true,
      selectedNodeIds: ['n1'],
    }
    await ctrl.conversation(dto, { user: { sub: 'u1' }, headers: {} } as never, res)

    expect(res.headers['Content-Type']).toBeUndefined()
    expect(res.writes).toEqual([])
    expect(stream).not.toHaveBeenCalled()
    expect(res.jsonBody).toEqual({
      code: 0,
      message: 'ok',
      data: { accepted: true, threadId: 'thread-1', sinceSeq: 9 },
    })
    // 位置参数逐一核对（与 off 路径 streamConversation 的实参表同构，⛔ 顺序即契约）
    expect(startRun).toHaveBeenCalledWith(
      'sess-1', // sessionId
      '画一只狐狸', // userMessage
      'u1', // userId
      'thread-1', // threadId
      undefined, // idempotencyKey（headers 里没有）
      'sk-1', // skillId
      'm-1', // model
      undefined, // focusNodeId（@deprecated）
      undefined, // attachments
      undefined, // refOrder
      undefined, // mentionedKeys
      true, // thinking
      undefined, // thinkingEffort
      undefined, // branchFromEntryId
      ['n1'], // selectedNodeIds
    )
  })

  it('on + 幂等键命中：JSON 告知复用（accepted=false），不触发新 run', async () => {
    process.env[ENV_KEY] = 'on'
    const startRun = vi.fn()
    const ctrl = makeController({
      startRun,
      checkIdempotency: async () => ({ status: 'processing' }),
    })
    const res = makeFakeRes()
    await ctrl.conversation(
      baseDto,
      { user: { sub: 'u1' }, headers: { 'idempotency-key': 'ik-1' } } as never,
      res,
    )

    expect(res.jsonBody).toMatchObject({
      code: 0,
      data: { accepted: false, reason: 'idempotent_hit', status: 'processing' },
    })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('on + 意图重复（not_idle）：JSON 告知复用，不触发新 run', async () => {
    process.env[ENV_KEY] = 'on'
    const startRun = vi.fn()
    const ctrl = makeController({ startRun, findDuplicateIntent: async () => ({ id: 'x' }) })
    const res = makeFakeRes()
    await ctrl.conversation(baseDto, { user: { sub: 'u1' }, headers: {} } as never, res)

    expect(res.jsonBody).toMatchObject({
      code: 0,
      data: { accepted: false, reason: 'not_idle' },
    })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('on + 会话越权（Forbidden）：JSON 告知，不触发新 run、不泄漏存在性', async () => {
    process.env[ENV_KEY] = 'on'
    const startRun = vi.fn()
    const ctrl = makeController({ startRun })
    // 覆写 sessionsService.findOne 抛 Forbidden
    const svc = (
      ctrl as unknown as {
        sessionsService: { findOne: (id: string, uid: string) => Promise<unknown> }
      }
    ).sessionsService
    const { ForbiddenException } = await import('@nestjs/common')
    vi.spyOn(svc, 'findOne').mockRejectedValue(new ForbiddenException())
    const res = makeFakeRes()
    await ctrl.conversation(baseDto, { user: { sub: 'u1' }, headers: {} } as never, res)

    expect(res.jsonBody).toMatchObject({
      code: 0,
      data: { accepted: false, reason: 'session_forbidden' },
    })
    expect(startRun).not.toHaveBeenCalled()
  })
})
