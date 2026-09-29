import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/** 与 pi-runtime tools/memory.ts 的常量保持一致（两侧纵深夹取，改一处必须同步另一处）。 */
export const MEMORY_CONTENT_MAX = 2000
export const MEMORY_RECALL_DEFAULT = 10
export const MEMORY_RECALL_MAX = 50

/**
 * P1 memory（spec docs/superpowers/specs/2026-09-29-agent-tool-p1-read-document-memory-design.md）：
 * agent 跨会话记忆落库。独立小服务（不并入 2700 行的 agent-canvas-tools.service）。
 */
@Injectable()
export class AgentMemoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async saveMemory(input: { userId: string; content: string }): Promise<{ id: string; createdAt: string }> {
    const content = (input.content ?? '').trim()
    if (!content) throw new BadRequestException('content required')
    const record = await this.prisma.agentMemory.create({
      data: { userId: input.userId, content: content.slice(0, MEMORY_CONTENT_MAX) },
    })
    return { id: record.id, createdAt: record.createdAt.toISOString() }
  }

  async searchMemory(input: {
    userId: string
    query?: string
    limit?: number
  }): Promise<{ items: { id: string; content: string; createdAt: string }[] }> {
    const query = (input.query ?? '').trim()
    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.floor(input.limit) : MEMORY_RECALL_DEFAULT
    const limit = Math.min(Math.max(rawLimit, 1), MEMORY_RECALL_MAX)
    const items = await this.prisma.agentMemory.findMany({
      where: { userId: input.userId, ...(query ? { content: { contains: query } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return {
      items: items.map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt.toISOString() })),
    }
  }
}
