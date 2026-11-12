import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'
import type { SubagentTaskSummary } from './subagent-task.service'

/**
 * D2 T5 只读查询面：`GET /threads/:threadId/state` 的 `subagentTasks` 字段。
 * 验证三件事：① 装配后透传 service.getSummaries 裁剪摘要；
 * ② 读失败 / 未装配 ⇒ fail-open 返回 []（跨 pod 存活的只读面，绝不因 D2 引入阻塞态）；
 * ③ 旧形状兼容：status / lastGSeq / pendingInterruption 仍按原契约存在。
 *
 * 注：service.getSummaries 内部已 catch（T3 已证），此处外层再兜一层，
 * 故「读失败」用例以 getSummaries 抛异常模拟，断言整段不抛、回落 []。
 */

function makePrismaStub() {
  return {
    agentEvent: {
      aggregate: vi.fn().mockResolvedValue({ _max: { gSeq: null } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentMessage: { create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    agentThread: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn(), update: vi.fn() },
    session: { findUnique: vi.fn(), update: vi.fn() },
    userAiPreferences: { findUnique: vi.fn() },
    idempotencyRecord: { findMany: vi.fn().mockResolvedValue([]) },
  }
}

/** 真实构造参表 15 个（subagentTasks 末位 @Optional，pendingInterruptions 第 14）。 */
function makeService(
  subagentTasks: { getSummaries: ReturnType<typeof vi.fn> } | undefined,
  pendingInterruptions: { getPending: ReturnType<typeof vi.fn> } | undefined,
) {
  const prisma = makePrismaStub()
  const service = new AgentService(
    prisma as never,
    { createFromAgent: vi.fn() } as never,
    { resolveForGeneration: vi.fn().mockResolvedValue(null) } as never,
    undefined, undefined, undefined, undefined, undefined, // 4-8
    undefined, undefined, undefined, undefined, undefined, // 9-13
    pendingInterruptions as never, // 14
    subagentTasks as never, // 15
  )
  return { prisma, service }
}

function stubService(service: AgentService, outcome: 'active' | 'settled' = 'settled') {
  vi.spyOn(service, 'assertThreadOwner').mockResolvedValue(undefined)
  vi.spyOn(service, 'reconcileLatestAssistant').mockResolvedValue({
    outcome,
    lastSeq: 0,
  } as never)
}

describe('D2 T5 state 只读查询面：subagentTasks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('★ 装配后透传 getSummaries 裁剪摘要（字段裁剪 + 上限 6 条）', async () => {
    const fake: SubagentTaskSummary[] = Array.from({ length: 8 }, (_, i) => ({
      callId: `c${i}`,
      status: i < 3 ? 'spawned' : 'completed',
      reason: i < 3 ? null : 'ok',
      taskPreview: `task-${i}`,
      startedAt: 1000 + i,
      endedAt: i < 3 ? null : 2000 + i,
    }))
    const tasks = { getSummaries: vi.fn().mockResolvedValue(fake) }
    const { service } = makeService(tasks, { getPending: vi.fn().mockResolvedValue(null), getLatest: vi.fn().mockResolvedValue(null) })
    stubService(service, 'active')
    const r = await service.getThreadResumeState('t1', 'u1')
    expect(tasks.getSummaries).toHaveBeenCalledWith('t1', expect.any(Number))
    expect(r.subagentTasks).toBe(fake)
    expect(r.status).toBe('in_progress')
    expect(r.pendingInterruption).toBeNull()
  })

  it('★ 读失败（getSummaries 抛异常）fail-open ⇒ subagentTasks 回落 []', async () => {
    const tasks = { getSummaries: vi.fn().mockRejectedValue(new Error('db down')) }
    const { service } = makeService(tasks, { getPending: vi.fn().mockResolvedValue(null), getLatest: vi.fn().mockResolvedValue(null) })
    stubService(service, 'settled')
    await expect(service.getThreadResumeState('t1', 'u1')).resolves.toMatchObject({
      status: 'complete',
      subagentTasks: [],
    })
  })

  it('★ getSummaries 返回 []（内层 fail-open 场景）⇒ 透传 []', async () => {
    const tasks = { getSummaries: vi.fn().mockResolvedValue([]) }
    const { service } = makeService(tasks, { getPending: vi.fn().mockResolvedValue(null), getLatest: vi.fn().mockResolvedValue(null) })
    stubService(service, 'settled')
    const r = await service.getThreadResumeState('t1', 'u1')
    expect(r.subagentTasks).toEqual([])
  })

  it('★ 未装配 subagentTasks（既有路径）⇒ 恒 [] 且旧形状四字段齐全', async () => {
    const { service } = makeService(undefined, { getPending: vi.fn().mockResolvedValue(null), getLatest: vi.fn().mockResolvedValue(null) })
    stubService(service, 'settled')
    const r = await service.getThreadResumeState('t1', 'u1')
    expect(r).toHaveProperty('subagentTasks')
    expect(r.subagentTasks).toEqual([])
    expect(r).toHaveProperty('status')
    expect(r).toHaveProperty('lastGSeq')
    expect(r).toHaveProperty('pendingInterruption')
    expect(r.pendingInterruption).toBeNull()
  })
})
