/**
 * P3 G3（D5 收口）：getMessages 的 queued **读时派生**。
 *
 * 背景：steer 在 turn 边界消费、followUp 在收尾边界消费，而 owner 流在 agent_end
 * 即收尾（早于 followUp 消费）⇒ 写时翻转要么过早要么依赖 runtime queue_update
 * 事件（刻意不进 SSE，session-manager.ts:1740 决策）⇒ schema 注释里的「终态由
 * 消费信号转 false」从未实现。
 *
 * 派生判据：`effectiveQueued = row.queued && 窗口内不存在 createdAt 更晚的 assistant 行`。
 * desc 分页下 reply 恒新于 user 行 ⇒ 必在同窗或更早页，窗口内判定即全局判定
 * （P3 计划 Review Focus 4 的页边界论证）。
 */
import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'

const base = new Date('2026-01-01T00:00:00Z')
let seq = 0
const row = (over: {
  role: 'user' | 'assistant'
  queued?: boolean
  offsetSec: number
  id?: string
  content?: string
}) => ({
  id: over.id ?? `r${++seq}`,
  sessionId: 's1',
  threadId: 's1:thread-a',
  role: over.role,
  content: over.content ?? `${over.role}-row`,
  queued: over.queued ?? false,
  metadata: null,
  createdAt: new Date(base.getTime() + over.offsetSec * 1000),
})

describe('getMessages queued 读时派生（P3 G3 / Review Focus 4）', () => {
  let service: AgentService
  const findMany = vi.fn()

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.PI_RUNTIME_MODE = 'active'
    delete process.env.PI_RUNTIME_URL
    service = new AgentService(
      {
        agentMessage: { create: vi.fn(), findMany, groupBy: vi.fn() },
        agentThread: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
        session: {
          findUnique: vi.fn().mockResolvedValue({ id: 's1', canvasData: null }),
          update: vi.fn(),
        },
        idempotencyRecord: {
          create: vi.fn(),
          findUnique: vi.fn(),
          updateMany: vi.fn(),
          deleteMany: vi.fn(),
        },
        userAiPreferences: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never,
      { createFromAgent: vi.fn() } as never,
      { resolveForGeneration: vi.fn() } as never,
    )
  })

  it('1：queued:true 且窗口内有更晚 assistant 行 ⇒ 派生为 false（已消费）', async () => {
    // findMany 返回 desc 序（ newest 在前）：assistant reply 新于 queued user 行
    findMany.mockResolvedValue([
      row({ role: 'assistant', offsetSec: 20, content: 'reply' }),
      row({ role: 'user', queued: true, offsetSec: 10, content: '插话' }),
    ])
    const { page } = await service.getMessages('s1', 's1:thread-a')
    const queuedRow = page.find((m) => m.content === '插话') as { queued: boolean }
    expect(queuedRow.queued).toBe(false)
  })

  it('2：queued:true 且无更晚 assistant 行 ⇒ 保持 true（仍在排队）', async () => {
    findMany.mockResolvedValue([
      row({ role: 'user', queued: true, offsetSec: 10, content: '插话' }),
      row({ role: 'user', queued: false, offsetSec: 5, content: '老消息' }),
    ])
    const { page } = await service.getMessages('s1', 's1:thread-a')
    const queuedRow = page.find((m) => m.content === '插话') as { queued: boolean }
    expect(queuedRow.queued).toBe(true)
  })

  it('3：assistant 行 / queued:false 行原样透传（不受派生污染）', async () => {
    findMany.mockResolvedValue([
      row({ role: 'assistant', offsetSec: 20, content: 'reply' }),
      row({ role: 'user', queued: false, offsetSec: 10 }),
    ])
    const { page } = await service.getMessages('s1', 's1:thread-a')
    const assistant = page.find((m) => m.role === 'assistant') as Record<string, unknown>
    const user = page.find((m) => m.role === 'user') as Record<string, unknown>
    expect(assistant.queued).toBe(false)
    expect(user.queued).toBe(false)
  })

  it('4：深分页——user 行在窗口老端、reply 更新于窗口内（desc 序 reply 必在同窗）⇒ 仍正确派生', async () => {
    // 模拟 take*2 overfetch 窗口：老端 queued user 行 + 窗口内多个更晚 assistant 行
    findMany.mockResolvedValue([
      row({ role: 'assistant', offsetSec: 90, content: 'late-reply' }),
      row({ role: 'user', offsetSec: 80 }),
      row({ role: 'assistant', offsetSec: 70, content: 'mid-reply' }),
      row({ role: 'user', queued: true, offsetSec: 10, content: 'old-queued' }),
    ])
    const { page } = await service.getMessages('s1', 's1:thread-a')
    const queuedRow = page.find((m) => m.content === 'old-queued') as { queued: boolean }
    expect(queuedRow.queued).toBe(false)
  })
})
