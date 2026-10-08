import { createServer, type Server } from 'http'
import type { Socket } from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isRetryableUpstreamError } from './upstream-retry'
import {
  UPSTREAM_FETCH_TIMEOUT_MS,
  UPSTREAM_POLL_TIMEOUT_MS,
  UpstreamTimeoutError,
  upstreamFetch,
} from './upstream-fetch'

/**
 * 用真实 HTTP server 造「连上了但永不响应」的场景 —— 这正是 2026-10-08
 * 生产事故的现场（隧道 TCP 健康、数据不回）。禁用假计时器：本模块的
 * 正确性恰恰依赖真实 timer 与真实 abort 的先后关系。
 */
let server: Server
let baseUrl: string
const sockets = new Set<Socket>()

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/hang') return // 故意不 end：模拟出海口楔死
    if (req.url === '/ok') {
      res.writeHead(200)
      res.end('ok')
      return
    }
    res.writeHead(404)
    res.end()
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

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('upstreamFetch', () => {
  it('正常响应原样返回', async () => {
    const res = await upstreamFetch(`${baseUrl}/ok`, { timeoutMs: 1000 })
    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe('ok')
  })

  it('上游连上但不返回 ⇒ 在 timeoutMs 附近抛出，不永久挂起', async () => {
    const started = Date.now()
    await expect(upstreamFetch(`${baseUrl}/hang`, { timeoutMs: 300 })).rejects.toBeInstanceOf(
      UpstreamTimeoutError,
    )
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(3000)
  })

  it('超时错误必须被 upstream-retry 判为可重试（文案契约，改文案即静默降级）', async () => {
    const err = await upstreamFetch(`${baseUrl}/hang`, { timeoutMs: 200 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamTimeoutError)
    // 这一条防的是「把 `timeout` 改成中文『超时』后重试不再触发」的静默回归。
    expect(isRetryableUpstreamError(err)).toBe(true)
  })

  it('调用方 signal 中止不伪装成超时（否则用户取消会被重试逻辑重放）', async () => {
    const controller = new AbortController()
    controller.abort()
    const err = await upstreamFetch(`${baseUrl}/hang`, {
      timeoutMs: 5000,
      signal: controller.signal,
    }).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(UpstreamTimeoutError)
    expect(isRetryableUpstreamError(err)).toBe(false)
  })

  it('超时后不残留已中止的控制器：下一次调用仍正常返回', async () => {
    await upstreamFetch(`${baseUrl}/hang`, { timeoutMs: 200 }).catch(() => undefined)
    const res = await upstreamFetch(`${baseUrl}/ok`, { timeoutMs: 1000 })
    expect(res.status).toBe(200)
  })

  it('超时预算必须落在编排层上限内（保住「不发假死单」这条不变式）', () => {
    // 创建类调用外面裹 withUpstreamRetry（3 次尝试，退避 1.5s + 3s）。
    // 这条断言防的是「有人把 UPSTREAM_FETCH_TIMEOUT_MS 调大」之后，
    // 编排层 LNKPI_IMAGE_GEN_TIMEOUT_SEC=180 先生效掐断，
    // 记录重新停在 generating —— 即本次事故的复发。
    const WORST_CASE_MS = UPSTREAM_FETCH_TIMEOUT_MS * 3 + 4500
    expect(WORST_CASE_MS).toBeLessThan(180_000)
    // 轮询上限必须明显短于单次尝试上限，否则「轮询被单次卡死吃掉」。
    expect(UPSTREAM_POLL_TIMEOUT_MS).toBeLessThan(UPSTREAM_FETCH_TIMEOUT_MS)
  })
})
