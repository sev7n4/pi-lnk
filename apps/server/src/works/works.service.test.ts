import 'reflect-metadata'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Test } from '@nestjs/testing'
import { WorksService } from './works.service'
import { PrismaService } from '../prisma/prisma.service'

const emptyRow = {
  id: 'w_1',
  title: '作品',
  coverUrl: null,
  type: 'canvas',
  category: null,
  authorId: 'u_1',
  likes: 0,
  views: 0,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  author: { id: 'u_1', nickname: '作者' },
}

async function buildService() {
  const work = {
    // findMany 必须始终返回数组：既服务 formatWork 的map，又被 spy 记录调用参数
    findMany: vi.fn(async () => [emptyRow]),
    count: vi.fn(async () => 1),
  }
  const moduleRef = await Test.createTestingModule({
    providers: [WorksService, { provide: PrismaService, useValue: { work } }],
  }).compile()
  return { service: moduleRef.get(WorksService), work }
}

describe('WorksService.findAll 分类口径（type 维度）', () => {
  let service: WorksService
  let work: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    const built = await buildService()
    service = built.service
    work = built.work
  })

  it('category=短片 命中 type=shortfilm（真实维度）', async () => {
    await service.findAll({ category: '短片' })
    expect(work.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: 'shortfilm' }) }),
    )
  })

  it('category=画布 命中 type=canvas', async () => {
    await service.findAll({ category: '画布' })
    expect(work.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: 'canvas' }) }),
    )
  })

  it('category=全部 不加 type 过滤条件', async () => {
    await service.findAll({ category: '全部' })
    expect(work.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }))
  })

  it('旧运营位值（2026-赛事/精选作品）不再作为 category 过滤来源，落到画布维度', async () => {
    await service.findAll({ category: '2026-赛事' })
    // 未知分类不得静默变成「无过滤」（那会伪装成「全部」）；口径固定为「非短片即画布」
    expect(work.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ category: expect.anything() }),
      }),
    )
    expect(work.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: 'canvas' }) }),
    )
  })

  it('search 过滤不受分类口径影响', async () => {
    await service.findAll({ search: '星海' })
    expect(work.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ title: { contains: '星海' } }) }),
    )
  })

  it('category 与 search 同时传入时两者都进 where', async () => {
    await service.findAll({ category: '短片', search: '星海' })
    expect(work.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: 'shortfilm', title: { contains: '星海' } },
      }),
    )
  })
})
