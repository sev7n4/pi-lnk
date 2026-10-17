import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class StoriesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(userId: string) {
    return this.prisma.story.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    })
  }

  async create(userId: string, data: { title: string; synopsis?: string; episodeCount?: number }) {
    // 2026-10-17 prompt 节点下线（PR feat/prompt-node-decommission）：剧集种子节点
    // 由 prompt-1（type:'prompt'）改为 text-1（type:'text'）——prompt 节点已退出
    // NODE_TYPES 白名单与创建入口，种子若继续种 prompt 会被画布动作链路静默丢弃。
    const session = await this.prisma.session.create({
      data: {
        userId,
        title: data.title,
        canvasData: JSON.stringify({
          nodes: [{
            id: 'text-1',
            type: 'text',
            position: { x: 250, y: 100 },
            data: { prompt: data.synopsis ?? data.title },
          }],
          edges: [],
        }),
      },
    })

    return this.prisma.story.create({
      data: {
        userId,
        title: data.title,
        synopsis: data.synopsis ?? '',
        sessionId: session.id,
        episodeCount: data.episodeCount ?? 1,
        coverUrl: 'https://images.unsplash.com/photo-1614850523459-c2f4c699c52e?w=800&q=80',
      },
    })
  }

  async findOne(id: string, userId?: string) {
    const story = await this.prisma.story.findUnique({ where: { id } })
    if (!story) throw new NotFoundException('故事不存在')
    if (userId && story.userId !== userId) throw new NotFoundException('故事不存在')
    return story
  }
}
