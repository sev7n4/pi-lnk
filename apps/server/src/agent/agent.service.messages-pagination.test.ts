import 'reflect-metadata'
import { BadRequestException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent.service'

/**
 * H1-a 服务端分页（Task 7）：
 * - D13：superseded 过滤不得发生在 take 之后 ⇒ overfetch limit*2，页不因过滤缩水；
 * - S5：长对话翻页必须取回头部，不重不漏（含同毫秒页边界，Review Focus #3）；
 * - 游标语义：nextCursor = 页内 desc 序末行（本页最早一行），下一页 where id < cursor.id。
 */

const base = new Date('2026-01-01T00:00:00Z')

function makeRows(sessionId: string, threadId: string) {
  // 6 行可见（u3..u1 + a3..a1），其中 a1 与 u1 同毫秒，制造同毫秒页边界
  return [
    { id: 'u3', sessionId, threadId, role: 'user', content: 'q3', createdAt: new Date(base.getTime() + 5000), metadata: null },
    { id: 'a3', sessionId, threadId, role: 'assistant', content: 'r3', createdAt: new Date(base.getTime() + 4000), metadata: null },
    { id: 'shadow1', sessionId, threadId, role: 'assistant', content: 'dup', createdAt: new Date(base.getTime() + 3000), metadata: JSON.stringify({ supersededBy: 'a2' }) },
    { id: 'u2', sessionId, threadId, role: 'user', content: 'q2', createdAt: new Date(base.getTime() + 3000), metadata: null },
    { id: 'a2', sessionId, threadId, role: 'assistant', content: 'r2', createdAt: new Date(base.getTime() + 2000), metadata: null },
    { id: 'u1b', sessionId, threadId, role: 'user', content: 'q1-late', createdAt: new Date(base.getTime() + 1000), metadata: null },
    { id: 'u1', sessionId, threadId, role: 'user', content: 'q1', createdAt: new Date(base.getTime() + 1000), metadata: null },
    { id: 'a1', sessionId, threadId, role: 'assistant', content: 'r1', createdAt: new Date(base.getTime() + 1000), metadata: null },
  ] // desc 序（createdAt desc, id desc），即 DB findMany 应返回的顺序
}

/** 模拟 DB：desc 排序（含 id 决胜）+ 游标 where（OR: createdAt lt / 同刻 id lt）+ take */
function fakeFindMany(all: ReturnType<typeof makeRows>) {
  return vi.fn(async (args: {
    where: {
      sessionId: string
      threadId: string
      OR?: Array<Record<string, unknown>>
    }
    orderBy: Array<{ createdAt: 'desc' } | { id: 'desc' }>
    take: number
  }) => {
    let rows = all.filter(
      (m) => m.sessionId === args.where.sessionId && m.threadId === args.where.threadId,
    )
    const or = args.where.OR
    if (or) {
      const ltDate = (or.find((c) => 'createdAt' in c && (c as { createdAt: { lt?: unknown } }).createdAt?.lt) as { createdAt: { lt: Date } }).createdAt.lt
      const tie = or.find((c) => (c as { id?: { lt: string } }).id?.lt) as
        | { createdAt: Date; id: { lt: string } }
        | undefined
      rows = rows.filter(
        (m) =>
          m.createdAt.getTime() < ltDate.getTime() ||
          (tie && m.createdAt.getTime() === tie.createdAt.getTime() && m.id < tie.id.lt),
      )
    }
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    return rows.slice(0, args.take)
  })
}

describe('AgentService getMessages 分页（H1-a）', () => {
  let agentMessageFindMany: ReturnType<typeof vi.fn>
  let service: AgentService
  const all = makeRows('s1', 't1')

  beforeEach(() => {
    agentMessageFindMany = fakeFindMany(all)
    service = new AgentService(
      {
        agentMessage: { create: vi.fn(), findMany: agentMessageFindMany },
        agentThread: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
        session: { findUnique: vi.fn(), update: vi.fn() },
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

  it('overfetch limit*2 且页不被 superseded 过滤缩水（D13）', async () => {
    const r = await service.getMessages('s1', 't1', undefined, 4)
    expect(agentMessageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 8,
      }),
    )
    // desc 前 4 可见行 = u3,a3,(shadow 滤掉),u2,a2 → 页满 4 条，asc 输出
    expect(r.page.map((x) => x.id)).toEqual(['a2', 'u2', 'a3', 'u3'])
    expect(r.hasMore).toBe(true)
    // 游标 = 页内 desc 序末行 = 本页最早一行 a2
    expect(r.nextCursor).toBeTruthy()
    const [, decodedId] = Buffer.from(r.nextCursor!, 'base64url').toString('utf8').split('|')
    expect(decodedId).toBe('a2')
  })

  it('翻页取回头部不重不漏（S5，含同毫秒页边界）', async () => {
    const page1 = await service.getMessages('s1', 't1', undefined, 4)
    const page2 = await service.getMessages('s1', 't1', page1.nextCursor!, 4)
    expect(page2.hasMore).toBe(false)
    expect(page2.nextCursor).toBeNull()
    const ids = [...page1.page, ...page2.page].map((x) => x.id)
    // 全量可见行恰好一次（两页各自 asc 输出），shadow 不可见，头部（最早行 a1）必须取回
    expect(ids).toEqual(['a2', 'u2', 'a3', 'u3', 'a1', 'u1', 'u1b'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('同毫秒行游标用 id 决胜：where 含 { createdAt: equals, id: lt }（Review Focus #3）', async () => {
    const page1 = await service.getMessages('s1', 't1', undefined, 5)
    // 页内 desc 末行 = u1b（同毫秒三行 u1b/u1/a1 中 id 最大）
    const [, decodedId] = Buffer.from(page1.nextCursor!, 'base64url').toString('utf8').split('|')
    expect(decodedId).toBe('u1b')
    await service.getMessages('s1', 't1', page1.nextCursor!, 5)
    const where = agentMessageFindMany.mock.calls.at(-1)![0].where as { OR?: unknown }
    expect(where.OR).toContainEqual({ createdAt: new Date(base.getTime() + 1000), id: { lt: 'u1b' } })
  })

  it('畸形 before 抛 BadRequestException 且不查 prisma', async () => {
    await expect(service.getMessages('s1', 't1', 'not-a-cursor!!', 10)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(agentMessageFindMany).not.toHaveBeenCalled()
  })
})
