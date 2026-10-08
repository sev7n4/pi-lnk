import { createServer, type Server } from 'http'
import type { Socket } from 'net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pollApimartImageTask } from './apimart-image-task'

/**
 * 回归靶心：2026-10-08 生产事故里 `completeImage()` 永不 settle，
 * 记录永久停在 `generating`（既不 failed 也不退款）。
 * 这里用真实 HTTP server 重放「连上了但永不返回」的现场。
 */
let server: Server
let baseUrl: string
const sockets = new Set<Socket>()
let mode: 'hang-then-complete' | 'always-hang' | 'failed' = 'always-hang'
let hits = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1
    if (mode === 'failed') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'failed', error: { message: 'boom' } } }))
      return
    }
    if (mode === 'hang-then-complete' && hits >= 2) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: { status: 'completed', result: { images: [{ url: 'https://cdn.example/x.png' }] } },
        }),
      )
      return
    }
    // 其余情况：故意不 end —— 模拟出海口楔死
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

beforeEach(() => {
  hits = 0
})

afterEach(() => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

type PollOpts = Parameters<typeof pollApimartImageTask>[0]

const opts = (over: Partial<PollOpts> = {}): PollOpts => ({
  baseUrl,
  apiKey: 'test-key',
  taskId: 'task-1',
  pollIntervalMs: 10,
  pollTimeoutMs: 120,
  ...over,
})

describe('pollApimartImageTask 在出海口楔死下的行为', () => {
  it('单次轮询超时不判死整条任务 —— 后续轮询恢复即成功', async () => {
    mode = 'hang-then-complete'
    const urls = await pollApimartImageTask(opts({ maxPollMs: 3000 }))
    expect(urls).toEqual(['https://cdn.example/x.png'])
    expect(hits).toBeGreaterThanOrEqual(2)
  })

  it('全程楔死时**有界失败**，绝不永久挂起（本次事故的核心回归）', async () => {
    mode = 'always-hang'
    const started = Date.now()
    await expect(pollApimartImageTask(opts({ maxPollMs: 300 }))).rejects.toThrow(/poll timeout/i)
    const elapsed = Date.now() - started
    // 上界 = maxPollMs + 一轮超时 + 余量；若 timeoutMs 没生效，这里会挂到测试超时。
    expect(elapsed).toBeLessThan(2000)
  })

  it('上游明确 failed 时立即抛出（不被轮询重试掩盖）', async () => {
    mode = 'failed'
    await expect(pollApimartImageTask(opts({ maxPollMs: 3000 }))).rejects.toThrow(/task failed/i)
    expect(hits).toBe(1)
  })
})
