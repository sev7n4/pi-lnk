import { describe, expect, it, vi } from 'vitest'
import {
  SUBAGENT_TASK_SWEEP_KEY, SUBAGENT_TASK_TTL_MS, SubagentTaskService,
} from './subagent-task.service'
import { interruptedOutcome, parseSubagentOutcome } from './subagent-task.status'

type Row = {
  id: string; threadId: string; callId: string; requestId: string
  status: string; reason: string | null; outcomeJson: string | null
  taskPreview: string | null; expiresAt: Date; startedAt: Date
  endedAt: Date | null; runId: string | null; parentSessionKey: string | null
}
function fakePrisma(rows: Row[]) {
  return {
    subagentTask: {
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        rows.push({ id: `r${rows.length}`, ...data } as Row)
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const byRequest = (where as { requestId?: string }).requestId
        const byPair = (where as { threadId_callId?: { threadId: string; callId: string } })
          .threadId_callId
        return rows.find((r) =>
          (byRequest !== undefined && r.requestId === byRequest) ||
          (byPair !== undefined && r.threadId === byPair.threadId
            && r.callId === byPair.callId)) ?? null
      }),
      updateMany: vi.fn(async ({ where, data }: {
        where: { callId?: string; status?: string; expiresAt?: { lt: Date } }
        data: Partial<Row>
      }) => {
        let n = 0
        for (const r of rows) {
          const idOk = where.callId === undefined || r.callId === where.callId
          const statusOk = where.status === undefined || r.status === where.status
          const expOk = where.expiresAt === undefined || r.expiresAt < where.expiresAt.lt
          if (idOk && statusOk && expOk) { Object.assign(r, data); n += 1 }
        }
        return { count: n }
      }),
      findMany: vi.fn(async ({ where }: { where: { threadId: string } }) =>
        rows.filter((r) => r.threadId === where.threadId)),
    },
  }
}
const now = 1_700_000_000_000

function makeService(prisma: ReturnType<typeof fakePrisma>,
  scheduler?: { registerHandler: ReturnType<typeof vi.fn> }) {
  return new SubagentTaskService(prisma as never, scheduler as never)
}

const spawnCall = {
  type: 'tool_call',
  data: { toolCallId: 'call_A', name: 'spawn_subagent',
    toolName: 'spawn_subagent', args: { task: '调研X' } },
}
const completedResult = {
  type: 'tool_result',
  data: { toolCallId: 'call_B', name: 'spawn_subagent',
    result: { details: { ok: true, report: 'R',
      usage: { turns: 3, durationMs: 78900, status: 'completed' } } } },
}

describe('D2 单据：开单据 / 幂等 / CAS', () => {
  it('tool_call 开单据：requestId=subagent:{callId}，expiresAt=startedAt+TTL，不存 task 全文', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    s.onTraceEvent(spawnCall, { threadId: 't1', runId: 'run-A' })
    await vi.waitFor(() => expect(p.subagentTask.create).toHaveBeenCalledOnce())
    const d = p.subagentTask.create.mock.calls[0]![0].data
    expect(d.requestId).toBe('subagent:call_A')
    expect(d.status).toBe('spawned')
    expect(new Date(d.expiresAt as Date).getTime() - new Date(d.startedAt as Date).getTime())
      .toBeLessThanOrEqual(SUBAGENT_TASK_TTL_MS)
    expect(JSON.stringify(d)).not.toContain('调研X'.repeat(200))
  })

  it('★ 幂等：同一 tool_call 到达两次只 create 一次、不覆盖 startedAt', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now + 999 })
    expect(p.subagentTask.create).toHaveBeenCalledTimes(1)
  })

  it('★ CAS 单点：settleTask 只翻 spawned，终态不复活', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    expect(await s.settleTask({ callId: 'call_A',
      outcome: parseSubagentOutcome(completedResult.data.result)! })).toBe(true)
    expect(await s.settleTask({ callId: 'call_A',
      outcome: interruptedOutcome('no_terminal_event') })).toBe(false)
  })

  it('★ sweep 竞态：sweep 不得覆盖已完成/已中断的终态', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    await s.settleTask({ callId: 'call_A',
      outcome: parseSubagentOutcome(completedResult.data.result)! })
    expect(await s.sweepExpired(now + SUBAGENT_TASK_TTL_MS * 2)).toBe(0)
    const rows = await p.subagentTask.findMany({ where: { threadId: 't1' } })
    expect(rows[0]!.status).toBe('completed')
  })

  it('sweep 只翻过期 spawned，reason=lease_expired；二次扫描 count=0', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    expect(await s.sweepExpired(now + 10_000)).toBe(0)
    expect(await s.sweepExpired(now + SUBAGENT_TASK_TTL_MS + 1)).toBe(1)
    const rows = await p.subagentTask.findMany({ where: { threadId: 't1' } })
    expect(rows[0]!.reason).toBe('lease_expired')
    expect(await s.sweepExpired(now + SUBAGENT_TASK_TTL_MS + 2)).toBe(0)
  })
})

describe('D2 单据：漏斗零副作用 / fail-open / 注册 / 摘要', () => {
  it('★ 非 spawn 帧零副作用：不触达任何 prisma 方法', () => {
    const p = fakePrisma([]); const s = makeService(p)
    s.onTraceEvent({ type: 'tool_call', data: { name: 'get_canvas_summary' } },
      { threadId: 't1' })
    s.onTraceEvent({ type: 'thinking', data: {} }, { threadId: 't1' })
    expect(p.subagentTask.create).not.toHaveBeenCalled()
    expect(p.subagentTask.updateMany).not.toHaveBeenCalled()
    expect(p.subagentTask.findUnique).not.toHaveBeenCalled()
  })

  it('turn_interrupted 只对已存在的 spawn 单据收口，其他 id 静默忽略', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    s.onTraceEvent({ type: 'turn_interrupted', data: {
      reason: 'no_terminal_event',
      outstandingToolCallIds: ['call_A', 'call_other_tool'],
    } }, { threadId: 't1' })
    await vi.waitFor(() => expect(p.subagentTask.updateMany).toHaveBeenCalled())
    const rows = await p.subagentTask.findMany({ where: { threadId: 't1' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('interrupted')
    expect(rows[0]!.reason).toBe('no_terminal_event')
  })

  it('fail-open：create 抛错不 throw、只 warn（不阻塞 SSE）', async () => {
    const p = fakePrisma([])
    p.subagentTask.create.mockRejectedValueOnce(new Error('db down'))
    const s = makeService(p)
    expect(() => s.onTraceEvent(spawnCall, { threadId: 't1' })).not.toThrow()
    await expect(s.openTask({ threadId: 't1', callId: 'call_X' })).resolves.toBeUndefined()
  })

  it('onModuleInit 注册 1min sweep handler（不新起 timer）', () => {
    const registerHandler = vi.fn()
    makeService(fakePrisma([]), { registerHandler }).onModuleInit()
    expect(registerHandler).toHaveBeenCalledTimes(1)
    expect(registerHandler.mock.calls[0]![0]).toBe(SUBAGENT_TASK_SWEEP_KEY)
    expect(typeof registerHandler.mock.calls[0]![1]).toBe('function')
  })

  it('getSummaries 只回裁剪字段、不含 outcomeJson/requestId/parentSessionKey', async () => {
    const p = fakePrisma([]); const s = makeService(p)
    await s.openTask({ threadId: 't1', callId: 'call_A', startedAt: now })
    const out = await s.getSummaries('t1', now)
    expect(out).toHaveLength(1)
    expect(Object.keys(out[0]!).sort()).toEqual(
      ['callId', 'endedAt', 'reason', 'startedAt', 'status', 'taskPreview'].sort(),
    )
  })
})
