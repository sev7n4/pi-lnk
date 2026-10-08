import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { studioApi } from '@/services/studio-api'
import { useGenerationPolling } from '@/composables/useGenerationPolling'

vi.mock('@/services/studio-api', () => ({
  studioApi: {
    getGeneration: vi.fn(),
  },
}))

describe('useGenerationPolling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not call onUpdate for tasks removed during poll await', async () => {
    let resolveFetch!: (v: unknown) => void
    const hang = new Promise((r) => {
      resolveFetch = r
    })
    vi.mocked(studioApi.getGeneration).mockImplementationOnce(() => hang as never)

    const onUpdate = vi.fn()
    const polling = useGenerationPolling(onUpdate)
    polling.start([{ recordId: 'rec-1', nodeId: 'node-1' }])

    await Promise.resolve()
    expect(studioApi.getGeneration).toHaveBeenCalledWith('rec-1')

    polling.removeByNodeId('node-1')

    resolveFetch({
      data: {
        data: {
          id: 'rec-1',
          type: 'image',
          prompt: 'x',
          status: 'completed',
          url: 'https://example.com/late.png',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(onUpdate).not.toHaveBeenCalled()
  })
})

// —— 诊断 C3：轮询墙钟 ——
describe('useGenerationPolling 墙钟', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function completedRecord(id: string) {
    return {
      data: {
        data: {
          id,
          type: 'image',
          prompt: 'x',
          status: 'completed',
          url: 'https://example.com/a.png',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
  }

  it('任务超过墙钟：回调 onTimeout 并移出轮询（不再发请求）', async () => {
    const onUpdate = vi.fn()
    const onTimeout = vi.fn()
    const polling = useGenerationPolling(onUpdate, { onTimeout, maxPollMs: 100 })
    polling.start([{ recordId: 'rec-1', nodeId: 'node-1' }])
    await vi.advanceTimersByTimeAsync(0)
    const callsAfterStart = vi.mocked(studioApi.getGeneration).mock.calls.length
    expect(callsAfterStart).toBeGreaterThan(0)

    // 推进到墙钟之外（且跨过一个 2s 轮询周期）
    await vi.advanceTimersByTimeAsync(2500)

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout).toHaveBeenCalledWith({ recordId: 'rec-1', nodeId: 'node-1' })
    // 超时后轮询已停：不再新增请求
    const callsAfterTimeout = vi.mocked(studioApi.getGeneration).mock.calls.length
    await vi.advanceTimersByTimeAsync(4000)
    expect(vi.mocked(studioApi.getGeneration).mock.calls.length).toBe(callsAfterTimeout)
  })

  it('任务在墙钟内完成：不触发 onTimeout', async () => {
    const onUpdate = vi.fn()
    const onTimeout = vi.fn()
    vi.mocked(studioApi.getGeneration).mockResolvedValue(completedRecord('rec-2') as never)
    const polling = useGenerationPolling(onUpdate, { onTimeout, maxPollMs: 100 })
    polling.start([{ recordId: 'rec-2', nodeId: 'node-2' }])
    await vi.advanceTimersByTimeAsync(2500)

    expect(onTimeout).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })
})
