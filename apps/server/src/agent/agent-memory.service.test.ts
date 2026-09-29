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

  it('searchMemory：有 query → JS 侧大小写不敏感子串过滤，扫描窗口 200 后按 limit 截断', async () => {
    // Review I-1：sqlite LIKE 对 ASCII 大小写不敏感（实测），故 query 语义 = 大小写不敏感子串。
    findMany.mockResolvedValue([
      { id: 'm1', content: 'Brand Color Is #0F4C81', createdAt: new Date('2026-09-29T01:00:00.000Z') },
      { id: 'm2', content: '无关记忆', createdAt: new Date('2026-09-29T01:00:00.000Z') },
    ])
    const out = await svc.searchMemory({ userId: 'u1', query: 'brand color', limit: 999 })
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    expect(out.items.map((i) => i.id)).toEqual(['m1'])
    await svc.searchMemory({ userId: 'u1', limit: 0 })
    expect((findMany.mock.calls[1][0] as { take: number }).take).toBe(1)
  })

  it('searchMemory：query 含 % / _ 不当作 LIKE 通配符（Review I-2 回归锁）', async () => {
    findMany.mockResolvedValue([
      { id: 'm1', content: '折扣是 50% 起', createdAt: new Date('2026-09-29T01:00:00.000Z') },
      { id: 'm2', content: '折扣是 90% 起', createdAt: new Date('2026-09-29T01:00:00.000Z') },
    ])
    const pct = await svc.searchMemory({ userId: 'u1', query: '%' })
    expect(pct.items.map((i) => i.id)).toEqual(['m1', 'm2'])
    const fifty = await svc.searchMemory({ userId: 'u1', query: '50%' })
    expect(fifty.items.map((i) => i.id)).toEqual(['m1'])
    findMany.mockResolvedValue([
      { id: 'm3', content: 'Brand Color Is #0F4C81', createdAt: new Date('2026-09-29T01:00:00.000Z') },
      { id: 'm4', content: 'Brand_and_x', createdAt: new Date('2026-09-29T01:00:00.000Z') },
    ])
    // 子串语义：字面 'and_x' 命中 m4；而 'b_and' 在 LIKE 下会经 `_` 通配命中 'Brand'（旧行为），
    // 子串语义下应零命中——这正是 I-2 修复要证明的。
    const literal = await svc.searchMemory({ userId: 'u1', query: 'and_x' })
    expect(literal.items.map((i) => i.id)).toEqual(['m4'])
    const wildcardLike = await svc.searchMemory({ userId: 'u1', query: 'b_and' })
    expect(wildcardLike.items).toEqual([])
  })
})
