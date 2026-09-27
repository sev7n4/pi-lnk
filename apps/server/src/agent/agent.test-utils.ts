/**
 * AgentService 单测公用桩件。
 *
 * 老 LangGraph runtime 退役后，AgentService 的唯一对话链路是 pi-runtime，
 * 所有「跑一轮对话」的用例都要桩 `createPiRuntimeClient`。这里集中提供
 * `stubPiClient` / `piEvent` / `usePiRuntime`，避免 5 个测试文件各写一份
 * （此前 pi-runtime.test.ts 里就已经有两份几乎重复的 stubPiClient）。
 *
 * 命名沿用 `src/studio/studio.test-utils.ts`：不以 `.test.ts` 结尾，
 * 因此不会被 vitest 的 `src/**\/*.test.ts` 收进测试集。
 */
import { vi } from 'vitest'
import { PiRuntimeError } from './pi-runtime/pi-runtime.client'
import type { PiRuntimeClient } from './pi-runtime/pi-runtime.client'
import type { PiRuntimeEvent } from './pi-runtime/pi-events'

/** 桩件上额外暴露的 spy 句柄，便于断言「有没有真的打出去」。 */
export type PiClientStub = PiRuntimeClient & {
  healthz: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
  createSessionReplacingStale: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  deleteSession: ReturnType<typeof vi.fn>
  listSkills: ReturnType<typeof vi.fn>
  streamEvents: ReturnType<typeof vi.fn>
}

/**
 * 脚本化 pi-runtime client：订阅 `streamEvents` 时同步回放给定事件后结束。
 *
 * 与真实 client 的 409 语义一致：`createSessionReplacingStale` 遇 409
 * 会删掉陈旧会话再重建（不复用，见 AgentService.ensurePiSession 注释）。
 */
export function stubPiClient(
  events: PiRuntimeEvent[],
  healthzOk = true,
  knownSkills: Array<{ name: string }> = [],
): PiClientStub {
  const deleteSession = vi.fn().mockResolvedValue(true)
  const createSession = vi.fn().mockResolvedValue({
    sessionId: 'x',
    provider: 'agnes',
    model: 'agnes-2.5-pro',
  })
  return {
    healthz: vi.fn().mockResolvedValue(healthzOk ? { status: 'ok' } : null),
    createSession,
    createSessionReplacingStale: vi.fn(async (sid: string, opts: never) => {
      try {
        return await createSession(sid, opts)
      } catch (err) {
        if (err instanceof PiRuntimeError && err.status === 409) {
          await deleteSession(sid)
          return await createSession(sid, opts)
        }
        throw err
      }
    }),
    prompt: vi.fn().mockResolvedValue(undefined),
    deleteSession,
    listSkills: vi.fn().mockResolvedValue({ skills: knownSkills }),
    streamEvents: vi.fn((_sessionId: string, onEvent: (event: PiRuntimeEvent) => void) => {
      for (const event of events) onEvent(event)
      return () => {}
    }),
  } as unknown as PiClientStub
}

export function piEvent(type: PiRuntimeEvent['type'], data: unknown): PiRuntimeEvent {
  return { type, ts: Date.now(), data } as PiRuntimeEvent
}
