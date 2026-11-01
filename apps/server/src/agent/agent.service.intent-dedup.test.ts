import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import { INTENT_DEDUP_WINDOW_MS } from './intent-dedup'

describe('AgentService.findDuplicateIntent（P4 意图级去重查询）', () => {
  const agentMessageCreate = vi.fn()
  const agentMessageFindMany = vi.fn()
  const agentThreadFindUnique = vi.fn()
  const agentThreadUpsert = vi.fn()
  const agentThreadUpdate = vi.fn()
  const sessionFindUnique = vi.fn()
  const sessionUpdate = vi.fn()
  const idempotencyRecordCreate = vi.fn()
  const idempotencyRecordFindUnique = vi.fn()
  const idempotencyRecordUpdateMany = vi.fn()
  const idempotencyRecordDeleteMany = vi.fn()
  const idempotencyRecordFindFirst = vi.fn()

  let service: AgentService

  beforeEach(() => {
    vi.restoreAllMocks()
    agentMessageCreate.mockResolvedValue({})
    agentMessageFindMany.mockResolvedValue([{ role: 'user', content: 'hello' }])
    agentThreadFindUnique.mockResolvedValue(null)
    agentThreadUpsert.mockResolvedValue({})
    agentThreadUpdate.mockResolvedValue({})
    sessionFindUnique.mockResolvedValue({ id: 's1', canvasData: null })
    sessionUpdate.mockResolvedValue({})
    idempotencyRecordCreate.mockResolvedValue({})
    idempotencyRecordFindUnique.mockResolvedValue(null)
    idempotencyRecordUpdateMany.mockResolvedValue({ count: 1 })
    idempotencyRecordDeleteMany.mockResolvedValue({ count: 0 })
    idempotencyRecordFindFirst.mockResolvedValue(null)

    service = new AgentService(
      {
        agentMessage: {
          create: agentMessageCreate,
          findMany: agentMessageFindMany,
        },
        agentThread: {
          findUnique: agentThreadFindUnique,
          upsert: agentThreadUpsert,
          update: agentThreadUpdate,
        },
        session: {
          findUnique: sessionFindUnique,
          update: sessionUpdate,
        },
        idempotencyRecord: {
          create: idempotencyRecordCreate,
          findUnique: idempotencyRecordFindUnique,
          updateMany: idempotencyRecordUpdateMany,
          deleteMany: idempotencyRecordDeleteMany,
          findFirst: idempotencyRecordFindFirst,
        },
        userAiPreferences: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  it('命中同 thread + 同归一化意图 + 未过期 + 近窗 ⇒ 返回 true', async () => {
    idempotencyRecordFindFirst.mockResolvedValue({ id: 'rec-1' })

    const hit = await service.findDuplicateIntent('t1', '生成红色的小汽车')

    expect(hit).toBe(true)
    expect(idempotencyRecordFindFirst).toHaveBeenCalledTimes(1)
    const where = idempotencyRecordFindFirst.mock.calls[0][0].where
    expect(where.threadId).toBe('t1')
    expect(where.normalizedIntent).toBe('生成红色的小汽车')
    expect(where.status).toEqual({ in: ['processing', 'completed'] })
    // 近窗 createdAt.gte 落在 [now-window, now] 内
    expect(where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(Date.now() - INTENT_DEDUP_WINDOW_MS - 1000)
    expect(where.createdAt.gte.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
    expect(where.expiresAt.gt).toBeInstanceOf(Date)
  })

  it('空归一化意图直接返回 false，不查库', async () => {
    const hit = await service.findDuplicateIntent('t1', '')
    expect(hit).toBe(false)
    expect(idempotencyRecordFindFirst).not.toHaveBeenCalled()
  })

  it('未命中 ⇒ 返回 false', async () => {
    idempotencyRecordFindFirst.mockResolvedValue(null)
    const hit = await service.findDuplicateIntent('t1', '生成红色的小汽车')
    expect(hit).toBe(false)
  })

  it('自定义窗口只影响 createdAt.gte 下界', async () => {
    idempotencyRecordFindFirst.mockResolvedValue({ id: 'r' })
    await service.findDuplicateIntent('t1', 'x', 30_000)
    const where = idempotencyRecordFindFirst.mock.calls[0][0].where
    expect(where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(Date.now() - 30_000 - 1000)
  })
})
