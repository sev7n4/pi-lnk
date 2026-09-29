import 'reflect-metadata'
import { BadRequestException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../prisma/prisma.service'
import { AgentMemoryService } from './agent-memory.service'

describe('AgentMemoryService', () => {
  let svc: AgentMemoryService
  const create = vi.fn()
  const findMany = vi.fn()

  beforeEach(async () => {
    vi.clearAllMocks()
    create.mockImplementation(async ({ data }: { data: { userId: string; content: string } }) => ({
      id: 'm1',
      userId: data.userId,
      content: data.content,
      createdAt: new Date('2026-09-29T01:00:00.000Z'),
    }))
    findMany.mockResolvedValue([])
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentMemoryService,
        { provide: PrismaService, useValue: { agentMemory: { create, findMany } } },
      ],
    }).compile()
    svc = moduleRef.get(AgentMemoryService)
  })

  it('saveMemory：trim + 2000 截断', async () => {
    const long = '  ' + '汉'.repeat(2100) + '  '
    const out = await svc.saveMemory({ userId: 'u1', content: long })
    expect(create).toHaveBeenCalledTimes(1)
    const body = create.mock.calls[0][0].data as { userId: string; content: string }
    expect(body.userId).toBe('u1')
    expect(body.content.length).toBe(2000)
    expect(out).toEqual({ id: 'm1', createdAt: '2026-09-29T01:00:00.000Z' })
  })

  it('saveMemory：空内容 → BadRequest', async () => {
    await expect(svc.saveMemory({ userId: 'u1', content: '   ' })).rejects.toBeInstanceOf(BadRequestException)
    expect(create).not.toHaveBeenCalled()
  })

  it('searchMemory：无 query → 只按 userId 过滤，倒序取 limit', async () => {
    findMany.mockResolvedValue([
      { id: 'm1', content: '品牌色 #0F4C81', createdAt: new Date('2026-09-29T01:00:00.000Z') },
    ])
    const out = await svc.searchMemory({ userId: 'u1' })
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    expect(out.items).toEqual([{ id: 'm1', content: '品牌色 #0F4C81', createdAt: '2026-09-29T01:00:00.000Z' }])
  })

  it('searchMemory：有 query → contains 过滤 + limit 夹取（Review#5 纵深防御）', async () => {
    await svc.searchMemory({ userId: 'u1', query: ' 品牌色 ', limit: 999 })
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', content: { contains: '品牌色' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    await svc.searchMemory({ userId: 'u1', limit: 0 })
    expect((findMany.mock.calls[1][0] as { take: number }).take).toBe(1)
  })
})
