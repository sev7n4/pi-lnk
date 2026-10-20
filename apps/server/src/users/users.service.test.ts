import 'reflect-metadata'
import { NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrismaService } from '../prisma/prisma.service'
import { UsersService } from './users.service'

const findUnique = vi.fn()

async function buildService() {
  const mod = await Test.createTestingModule({
    providers: [UsersService, { provide: PrismaService, useValue: { user: { findUnique } } }],
  }).compile()
  return mod.get(UsersService)
}

// WorkType 只有两个合法值：'canvas' | 'shortfilm'
const creator = {
  id: 'u_1',
  nickname: '墨行者',
  avatar: null,
  points: 1024,
  membership: 'free',
  createdAt: new Date('2026-04-01T00:00:00Z'),
  works: [
    {
      id: 'w_1',
      title: '星海回响',
      coverUrl: 'https://cdn/x.jpg',
      type: 'shortfilm',
      sessionId: null,
      likes: 12,
      views: 340,
      category: 'series-a',
      createdAt: new Date('2026-10-01T00:00:00Z'),
    },
  ],
  _count: { works: 1 },
}

describe('UsersService.findCreator（公开载荷）', () => {
  beforeEach(() => {
    findUnique.mockReset()
    findUnique.mockResolvedValue(creator)
  })

  it('不返回 points / membership（公开页不暴露账户体系）', async () => {
    const svc = await buildService()
    const data = await svc.findCreator('u_1')
    expect(data.user).not.toHaveProperty('points')
    expect(data.user).not.toHaveProperty('membership')
  })

  it('返回封面与统计所需的 id/nickname/avatar/workCount/createdAt', async () => {
    const svc = await buildService()
    const data = await svc.findCreator('u_1')
    // 整体 toEqual：多一个字段（如漏删 membership）立刻红，避免用 toMatchObject 放过
    expect(data.user).toEqual({
      id: 'u_1',
      nickname: '墨行者',
      avatar: undefined,
      workCount: 1,
      createdAt: '2026-04-01T00:00:00.000Z',
    })
    expect(data.works[0]).toMatchObject({ id: 'w_1', coverUrl: 'https://cdn/x.jpg', likes: 12, views: 340 })
  })

  it('创作者不存在时抛 NotFoundException', async () => {
    findUnique.mockResolvedValue(null)
    const svc = await buildService()
    await expect(svc.findCreator('nope')).rejects.toBeInstanceOf(NotFoundException)
  })
})
