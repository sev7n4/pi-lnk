/**
 * Epic 2 Task 9（2026-11-04）：余额事件化——user 级 credit_tx SSE 客户端。
 *
 * 传输与 agent 旁听流同款约束：要带 auth 头 ⇒ 用不了浏览器 EventSource，
 * 走 fetch + 手工帧解析（复用 observer-stream 的 extractSseFrames）。
 * - 认证头：localStorage token（与 api.ts 同源）；
 * - 断线指数退避重连（1s→2s→4s→…封顶 30s；成功连上即复位）；
 * - 帧协议：`:` 注释帧（ready）忽略；`{"type":"heartbeat"}` 忽略；其余 JSON 帧回 onEvent；
 * - 返回 stop()：组件卸载即断（abort + 停重连）。
 */

import { extractSseFrames } from '@/components/agent/observer-stream'
import { apiUrl } from '@/services/api-base'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_CAP_MS = 30_000

export interface PointEventsConnection {
  stop: () => void
}

export function connectPointEvents(onEvent: (ev: { type: string; data?: unknown }) => void): PointEventsConnection {
  const controller = new AbortController()
  let stopped = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  async function run() {
    while (!stopped) {
      try {
        const token = localStorage.getItem('token')
        const res = await fetch(apiUrl('/api/membership/point-events'), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
          // SSE 长连接天然不可缓存；no-store 防 ETag 304 空体陷阱
          cache: 'no-store',
        })
        if (!res.ok || !res.body) throw new Error(`point-events ${res.status}`)
        attempt = 0
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done || stopped) break
          buffer += decoder.decode(value, { stream: true })
          const { frames, rest } = extractSseFrames(buffer)
          buffer = rest
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const raw = line.slice(5).trim()
              if (!raw) continue
              try {
                const ev = JSON.parse(raw) as { type: string; data?: unknown }
                if (ev.type === 'heartbeat') continue
                onEvent(ev)
              } catch {
                // 畸形帧丢弃，不中断连接
              }
            }
          }
        }
      } catch {
        // 网络错误/abort：走退避（stopped 时 abort 也会到这，直接退出）
      }
      if (stopped) break
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_CAP_MS)
      attempt += 1
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, delay)
      })
    }
  }

  void run()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      controller.abort()
    },
  }
}
