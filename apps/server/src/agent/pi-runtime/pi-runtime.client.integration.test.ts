/**
 * PiRuntimeClient · hermetic SSE 契约仿真集成测试
 *
 * 目标（对应 spec R-TEST-1「端到端集成测试」）：用**真实** `PiRuntimeClient` + **真实**
 * 全局 `fetch` 打**本地环回** Node HTTP 服务器（SSE 契约仿真），验证：
 *   1. `streamEvents` 真实 SSE 解析路径（event:/data: 帧、`:` 心跳注释帧忽略、跨 TCP 分片帧）
 *   2. `prompt()` POST 契约（202 成功 / 4xx 抛 PiRuntimeError）
 *   3. `streamEvents` 404 立即 onError（不进入 120s 重连预算）
 *
 * ⚠️ 不连真实 pi-runtime 容器：真实容器在 CI 起服务 + 网络出网 → flaky + 违反气密目标。
 *    行业最佳实践（claude/codex/workbuddy 一致）：用本地契约仿真服务器验证真实客户端代码路径，
 *    既拿到「真实 I/O 集成覆盖」又不引入外部网络依赖。判据 R-IO-1 的零散落 `upstreamFetch`
 *    已保证本测试不触真实出网。
 */
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PiRuntimeClient, PiRuntimeError, parseSseFrames } from './pi-runtime.client'

// 构造一段可控的 SSE 字节流（确定性，用于 parseSseFrames 单测）
function toStream(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(s))
      controller.close()
    },
  })
}

describe('parseSseFrames · 帧解析（确定性）', () => {
  it('忽略 : 心跳注释帧 + 多帧合一 + JSON 解析', async () => {
    const input = [
      ': heartbeat\n',
      'event: agent_start\n',
      'data: {"type":"agent_start","data":{}}\n',
      '\n',
      ': keep-alive\n',
      'event: message_update\n',
      'data: {"type":"message_update","data":{"event":{"type":"text_delta","delta":"hi"}}}\n',
      '\n',
    ].join('')
    const frames = []
    for await (const f of parseSseFrames(toStream(input))) frames.push(f)
    expect(frames).toHaveLength(2)
    expect(frames[0]?.event).toBe('agent_start')
    expect(frames[0]?.data).toEqual({ type: 'agent_start', data: {} })
    expect(frames[1]?.event).toBe('message_update')
    expect((frames[1]?.data as { data: { event: { delta: string } } }).data.event.delta).toBe('hi')
  })

  it('单帧被拆成两次分片仍正确拼接', async () => {
    const full =
      'event: agent_end\ndata: {"type":"agent_end","data":{"status":"completed"}}\n\n'
    const [a, b] = [full.slice(0, 20), full.slice(20)]
    const frames = []
    for await (const f of parseSseFrames(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode(a))
          controller.enqueue(enc.encode(b))
          controller.close()
        },
      }),
    )) {
      frames.push(f)
    }
    expect(frames).toHaveLength(1)
    expect(frames[0]?.event).toBe('agent_end')
    expect((frames[0]?.data as { data: { status: string } }).data.status).toBe('completed')
  })
})

describe('PiRuntimeClient · hermetic SSE 契约仿真（真实 fetch + 本地服务器）', () => {
  let server: Server
  let baseUrl: string
  let promptStatus = 202

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? ''
      // POST /sessions/<id>/prompt
      if (req.method === 'POST' && /\/sessions\/[^/]+\/prompt$/.test(url)) {
        res.writeHead(promptStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify({}))
        return
      }
      const m = url.match(/\/sessions\/([^/]+)\/events/)
      if (m) {
        const id = m[1]
        if (id === 'err404') {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        // 心跳注释帧：必须被 parseSseFrames 忽略
        res.write(': heartbeat\n\n')
        res.write('event: agent_start\n')
        res.write('data: {"type":"agent_start","data":{}}\n\n')
        // 跨 TCP 分片帧：一个 SSE 帧被拆成两次 write，验证增量解析
        res.write('event: message_update\ndata: {"type":"message_update","data":{"event":{"type":"text')
        res.write('_delta","delta":"hi"}}}\n\n')
        res.write('event: agent_end\ndata: {"type":"agent_end","data":{"status":"completed"}}\n\n')
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function makeClient() {
    return new PiRuntimeClient({ baseUrl })
  }

  it('streamEvents 解析真实 SSE：心跳忽略 + 跨分片帧 + 事件顺序', async () => {
    const received: Array<{ type: string; data: unknown }> = []
    const done = new Promise<void>((resolve, reject) => {
      const unsub = makeClient().streamEvents(
        'ok',
        (e) => {
          received.push(e as { type: string; data: unknown })
          if (e.type === 'agent_end') resolve()
        },
        (err) => reject(err),
      )
      void unsub
    })
    await expect(done).resolves.toBeUndefined()
    expect(received.map((e) => e.type)).toEqual(['agent_start', 'message_update', 'agent_end'])
    expect((received[1].data as { event: { delta: string } }).event.delta).toBe('hi')
  })

  it('streamEvents 404 → onError(PiRuntimeError 404) 立即终止', async () => {
    const err = new Promise<unknown>((resolve) => {
      makeClient().streamEvents(
        'err404',
        () => {},
        (e) => resolve(e),
      )
    })
    const e = await err
    expect(e).toBeInstanceOf(PiRuntimeError)
    expect((e as PiRuntimeError).status).toBe(404)
  })

  it('prompt() 202 成功；409 抛 PiRuntimeError(409)', async () => {
    promptStatus = 202
    await expect(makeClient().prompt('ok', 'hi')).resolves.toBeUndefined()

    promptStatus = 409
    let thrown: unknown
    try {
      await makeClient().prompt('ok', 'hi')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(PiRuntimeError)
    expect((thrown as PiRuntimeError).status).toBe(409)
  })
})
