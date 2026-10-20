import 'reflect-metadata'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PrismaService } from '../prisma/prisma.service'
import { UsersService } from './users.service'

const findUnique = vi.fn()
const followCreate = vi.fn()
const followDeleteMany = vi.fn()
const followFindUnique = vi.fn()
const followCount = vi.fn()
const workFindMany = vi.fn()
const userUpdate = vi.fn()

async function buildService() {
  const mod = await Test.createTestingModule({
    providers: [
      UsersService,
      {
        provide: PrismaService,
        useValue: {
          user: { findUnique, update: userUpdate },
          work: { findMany: workFindMany },
          follow: {
            create: followCreate,
            deleteMany: followDeleteMany,
            findUnique: followFindUnique,
            count: followCount,
          },
        },
      },
    ],
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
  pinnedWorkIds: '[]',
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
  _count: { works: 1, followers: 3, following: 5 },
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

  it('返回封面与统计所需的 id/nickname/avatar/workCount/createdAt + 关注计数 + 置顶列表', async () => {
    const svc = await buildService()
    const data = await svc.findCreator('u_1')
    // 整体 toEqual：多一个字段（如漏删 membership）立刻红，避免用 toMatchObject 放过
    expect(data.user).toEqual({
      id: 'u_1',
      nickname: '墨行者',
      avatar: undefined,
      workCount: 1,
      followersCount: 3,
      followingCount: 5,
      pinnedWorkIds: [],
      createdAt: '2026-04-01T00:00:00.000Z',
    })
    expect(data.works[0]).toMatchObject({ id: 'w_1', coverUrl: 'https://cdn/x.jpg', likes: 12, views: 340 })
  })

  it('pinnedWorkIds 脏值（非法 JSON / 非数组）回落空数组，不让创作者页整页崩', async () => {
    findUnique.mockResolvedValue({ ...creator, pinnedWorkIds: 'not-json' })
    const svc = await buildService()
    expect((await svc.findCreator('u_1')).user.pinnedWorkIds).toEqual([])
  })

  it('pinnedWorkIds 合法 JSON 数组被解析出来', async () => {
    findUnique.mockResolvedValue({ ...creator, pinnedWorkIds: '["w_1","w_2"]' })
    const svc = await buildService()
    expect((await svc.findCreator('u_1')).user.pinnedWorkIds).toEqual(['w_1', 'w_2'])
  })

  it('创作者不存在时抛 NotFoundException', async () => {
    findUnique.mockResolvedValue(null)
    const svc = await buildService()
    await expect(svc.findCreator('nope')).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('UsersService 关注（2026-10-21 P2）', () => {
  beforeEach(() => {
    followCreate.mockReset()
    followDeleteMany.mockReset()
    followFindUnique.mockReset()
    followCount.mockReset()
    findUnique.mockReset()
    // 默认：已关注 2 人
    followCount.mockResolvedValue(2)
  })

  it('自关注抛 BadRequestException（不发请求）', async () => {
    const svc = await buildService()
    await expect(svc.follow('me', 'me')).rejects.toBeInstanceOf(BadRequestException)
    expect(followCreate).not.toHaveBeenCalled()
  })

  it('关注目标不存在抛 NotFoundException', async () => {
    findUnique.mockResolvedValue(null)
    const svc = await buildService()
    await expect(svc.follow('me', 'nope')).rejects.toBeInstanceOf(NotFoundException)
    expect(followCreate).not.toHaveBeenCalled()
  })

  it('首次关注返回 following:true 与最新粉丝数', async () => {
    findUnique.mockResolvedValue({ id: 'other' })
    followCreate.mockResolvedValue({ id: 'f_1' })
    followCount.mockResolvedValue(3)
    const svc = await buildService()
    expect(await svc.follow('me', 'other')).toEqual({ following: true, followersCount: 3 })
    expect(followCreate).toHaveBeenCalledWith({ data: { followerId: 'me', followingId: 'other' } })
  })

  it('重复关注幂等：捕获唯一键冲突后仍返回 following:true（用户连点两次不报错）', async () => {
    findUnique.mockResolvedValue({ id: 'other' })
    followCreate.mockRejectedValue({ code: 'P2002' })
    followCount.mockResolvedValue(3)
    const svc = await buildService()
    expect(await svc.follow('me', 'other')).toEqual({ following: true, followersCount: 3 })
  })

  it('unfollow 幂等：未关注（deleteMany 命中 0 行）也返回 following:false', async () => {
    followDeleteMany.mockResolvedValue({ count: 0 })
    followCount.mockResolvedValue(1)
    const svc = await buildService()
    expect(await svc.unfollow('me', 'other')).toEqual({ following: false, followersCount: 1 })
  })

  it('unfollow 取消成功时粉丝数下降', async () => {
    followDeleteMany.mockResolvedValue({ count: 1 })
    followCount.mockResolvedValue(1)
    const svc = await buildService()
    expect(await svc.unfollow('me', 'other')).toEqual({ following: false, followersCount: 1 })
  })

  it('relation 返回是否已关注', async () => {
    followFindUnique.mockResolvedValue({ id: 'f_1' })
    const svc = await buildService()
    expect(await svc.relation('me', 'other')).toEqual({ following: true })

    followFindUnique.mockResolvedValue(null)
    expect(await svc.relation('me', 'other')).toEqual({ following: false })
  })
})

describe('UsersService 置顶作品（2026-10-21 P2）', () => {
  beforeEach(() => {
    workFindMany.mockReset()
    userUpdate.mockReset()
  })

  it('超过 2 个抛 BadRequestException（不查库不写库）', async () => {
    const svc = await buildService()
    await expect(svc.setPinnedWorks('me', ['a', 'b', 'c'])).rejects.toBeInstanceOf(BadRequestException)
    expect(workFindMany).not.toHaveBeenCalled()
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('置顶他人作品抛 BadRequestException', async () => {
    workFindMany.mockResolvedValue([{ id: 'other', authorId: 'someone_else' }])
    const svc = await buildService()
    await expect(svc.setPinnedWorks('me', ['other'])).rejects.toBeInstanceOf(BadRequestException)
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('作品不存在抛 BadRequestException（查库少一条即视为非法）', async () => {
    workFindMany.mockResolvedValue([{ id: 'w1', authorId: 'me' }])
    const svc = await buildService()
    await expect(svc.setPinnedWorks('me', ['w1', 'w2'])).rejects.toBeInstanceOf(BadRequestException)
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('合法写入并回读（持久化为 JSON 字符串）', async () => {
    workFindMany.mockResolvedValue([
      { id: 'w1', authorId: 'me' },
      { id: 'w2', authorId: 'me' },
    ])
    userUpdate.mockResolvedValue({ pinnedWorkIds: '["w1","w2"]' })
    const svc = await buildService()
    expect(await svc.setPinnedWorks('me', ['w1', 'w2'])).toEqual({ pinnedWorkIds: ['w1', 'w2'] })
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'me' },
      data: { pinnedWorkIds: '["w1","w2"]' },
    })
  })

  it('空数组合法（清空置顶）', async () => {
    userUpdate.mockResolvedValue({ pinnedWorkIds: '[]' })
    const svc = await buildService()
    expect(await svc.setPinnedWorks('me', [])).toEqual({ pinnedWorkIds: [] })
  })

  it('自动去重：同一 id 重复传入只算一个（不因重复触发 >2 误报）', async () => {
    workFindMany.mockResolvedValue([{ id: 'w1', authorId: 'me' }])
    userUpdate.mockResolvedValue({ pinnedWorkIds: '["w1"]' })
    const svc = await buildService()
    expect(await svc.setPinnedWorks('me', ['w1', 'w1'])).toEqual({ pinnedWorkIds: ['w1'] })
  })
})
