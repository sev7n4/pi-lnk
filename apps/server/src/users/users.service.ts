import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/**
 * 置顶作品上限。2 张是产品决策：多了就失去「精选」意义，且创作者页首屏要留位给身份行。
 */
const MAX_PINNED_WORKS = 2

/** 解析 User.pinnedWorkIds（JSON 字符串）。脏值一律回落空数组。 */
function parsePinnedWorkIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string')
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    // 存量脏值不该让整个创作者页崩
    return []
  }
}

@Injectable()
export class UsersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findCreator(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        works: {
          orderBy: { createdAt: 'desc' },
          take: 48,
        },
        _count: { select: { works: true, followers: true, following: true } },
      },
    })
    if (!user) throw new NotFoundException('创作者不存在')

    return {
      user: {
        id: user.id,
        nickname: user.nickname,
        avatar: user.avatar ?? undefined,
        // 公开页不暴露账户体系（points / membership）；workCount 非敏感，保留
        workCount: user._count.works,
        followersCount: user._count.followers,
        followingCount: user._count.following,
        pinnedWorkIds: parsePinnedWorkIds(user.pinnedWorkIds),
        createdAt: user.createdAt.toISOString(),
      },
      works: user.works.map((w) => ({
        id: w.id,
        title: w.title,
        coverUrl: w.coverUrl,
        type: w.type,
        sessionId: w.sessionId ?? undefined,
        likes: w.likes,
        views: w.views,
        category: w.category ?? undefined,
        createdAt: w.createdAt.toISOString(),
      })),
    }
  }

  // ---------------------------------------------------------------- 关注

  /** 关注。幂等：重复关注（P2002）转成成功，不向用户报错。 */
  async follow(followerId: string, followingId: string) {
    if (followerId === followingId) {
      throw new BadRequestException('不能关注自己')
    }
    const target = await this.prisma.user.findUnique({
      where: { id: followingId },
      select: { id: true },
    })
    if (!target) throw new NotFoundException('用户不存在')

    try {
      await this.prisma.follow.create({
        data: { followerId, followingId },
      })
    } catch (err) {
      // P2002 = 复合唯一冲突 = 已关注过。用户连点两次不该看到报错。
      const code = (err as { code?: string } | null)?.code
      if (code !== 'P2002') throw err
    }
    const followersCount = await this.prisma.follow.count({ where: { followingId } })
    return { following: true, followersCount }
  }

  /** 取关。幂等：未关注（deleteMany 命中 0 行）也返回成功态。 */
  async unfollow(followerId: string, followingId: string) {
    await this.prisma.follow.deleteMany({ where: { followerId, followingId } })
    const followersCount = await this.prisma.follow.count({ where: { followingId } })
    return { following: false, followersCount }
  }

  /** 当前登录者是否已关注目标用户。 */
  async relation(followerId: string, followingId: string) {
    if (followerId === followingId) return { following: false }
    const found = await this.prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId } },
      select: { id: true },
    })
    return { following: found !== null }
  }

  // ------------------------------------------------------------ 置顶作品

  /**
   * 设置置顶作品。三重校验（双闸的服务端侧）：
   *   ① 上限 ≤2；② 全部属于本人；③ 全部真实存在。
   * 任一不满足即 400，且**不写库**。
   */
  async setPinnedWorks(userId: string, workIds: string[]) {
    const ids = [...new Set(workIds)]
    if (ids.length > MAX_PINNED_WORKS) {
      throw new BadRequestException(`置顶作品最多 ${MAX_PINNED_WORKS} 个`)
    }
    if (ids.length > 0) {
      const works = await this.prisma.work.findMany({
        where: { id: { in: ids } },
        select: { id: true, authorId: true },
      })
      const ownsAll =
        works.length === ids.length && works.every((w) => w.authorId === userId)
      if (!ownsAll) {
        throw new BadRequestException('只能置顶自己的作品')
      }
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { pinnedWorkIds: JSON.stringify(ids) },
    })
    return { pinnedWorkIds: ids }
  }
}
