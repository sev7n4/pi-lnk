import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/** 与 pi-runtime tools/memory.ts 的常量保持一致（两侧纵深夹取，改一处必须同步另一处）。 */
export const MEMORY_CONTENT_MAX = 2000
export const MEMORY_RECALL_DEFAULT = 10
export const MEMORY_RECALL_MAX = 50
/**
 * 关键词检索的扫描窗口（最近 N 条）。
 * 不用 SQL LIKE：① sqlite LIKE 对 ASCII **大小写不敏感**且 `%`/`_` 是通配符（用户说「折扣 50%」时
 * 查 `50%` 会退化成通配召回无关记忆，Prisma 又不支持 ESCAPE 子句）；② 语义要的是「子串」不是「模式」。
 * 故改为拉取最近 N 条后 JS 侧过滤（终审 I-1/I-2）。
 */
export const MEMORY_SCAN_MAX = 200

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

  /**
   * 分词：空白/标点切分；CJK 串按 bigram（单字串回退整字）——中英混合 query 的子串召回。
   * bigram 让「整理」能命中「整理画布」，也天然兼容多字中文词的部分匹配。
   */
  private tokenize(query: string): string[] {
    const tokens: string[] = []
    for (const raw of query.toLowerCase().split(/[\s,，。;；、!！?？]+/)) {
      if (!raw) continue
      if (/[\u4e00-\u9fff]/.test(raw)) {
        if (raw.length === 1) tokens.push(raw)
        for (let i = 0; i < raw.length - 1; i++) tokens.push(raw.slice(i, i + 2))
      } else {
        tokens.push(raw)
      }
    }
    return tokens
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
    const rows = await this.prisma.agentMemory.findMany({
      where: { userId: input.userId },
      orderBy: { createdAt: 'desc' },
      take: query ? MEMORY_SCAN_MAX : limit,
    })
    // 分词打分召回（审计 #7）：OR 命中 + 计分（全 token 命中的排前），零分过滤。
    // % / _ 天然按普通子串处理（不是 LIKE，Review I-2 语义保持）；同分保持
    // findMany 的 createdAt 倒序（Array.prototype.sort 稳定排序）。
    let matched: typeof rows
    if (!query) {
      matched = rows
    } else {
      const tokens = this.tokenize(query)
      const scored = rows
        .map((m) => {
          const content = m.content.toLowerCase()
          const score = tokens.reduce((acc, t) => acc + (content.includes(t) ? 1 : 0), 0)
          return { m, score }
        })
        .filter((x) => x.score > 0)
      scored.sort((a, b) => b.score - a.score)
      matched = scored.map((x) => x.m)
    }
    const items = matched.slice(0, limit)
    return {
      items: items.map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt.toISOString() })),
    }
  }
}
