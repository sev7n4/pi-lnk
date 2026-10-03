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
 * 记忆作用域（spec 2026-10-03-agent-memory-scope-isolation-design.md §3.1）。
 * - canvas：仅本画布可见，`sessionId`（= Session.id）必填，`save_memory` 默认写这里
 * - user：该用户全部画布可见，只有显式 `scope:'user'` 才写这里（偏好/品牌/暗号）
 * 保持只有两个字面量，不加第三种（YAGNI）。
 */
export type AgentMemoryScope = 'canvas' | 'user'

/** 召回时的作用域过滤；'any' = 不限（跨画布条目靠 crossCanvas 标记自曝，不静默丢弃）。 */
export type AgentMemoryScopeFilter = AgentMemoryScope | 'any'

/** 召回条目：归属三字段随行返回，模型据此判断「这是记忆，不是当前观察」。 */
export interface AgentMemoryItem {
  id: string
  content: string
  createdAt: string
  scope: string
  sessionId: string | null
  /**
   * 来自另一个画布的记忆（scope='canvas' 且 sessionId ≠ 当前会话）——本次事故的直接止血点。
   * 必须是**数据**字段而不是提示词规则：事故证明模型会违反写得再清楚的提示词。
   */
  crossCanvas: boolean
}

/**
 * 召回档位：0 = 本画布，1 = 用户级（显式跨会话事实），2 = 其他画布（最易被误当成本画布观察结果）。
 * 无当前画布可比时（sessionId 缺失）不降档，全部按原序。
 */
function tier(m: { scope: string; sessionId: string | null }, currentSession: string | null): number {
  if (!currentSession) return 0
  if (m.scope === 'user') return 1
  return (m.sessionId ?? null) === currentSession ? 0 : 2
}

/**
 * P1 memory（spec docs/superpowers/specs/2026-09-29-agent-tool-p1-read-document-memory-design.md）：
 * agent 记忆落库。独立小服务（不并入 2700 行的 agent-canvas-tools.service）。
 */
@Injectable()
export class AgentMemoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async saveMemory(input: {
    userId: string
    content: string
    scope?: AgentMemoryScope
    sessionId?: string
  }): Promise<{ id: string; createdAt: string; scope: AgentMemoryScope; sessionId: string | null }> {
    const content = (input.content ?? '').trim()
    if (!content) throw new BadRequestException('content required')
    const requested = input.scope === 'user' ? 'user' : 'canvas'
    const sessionId = requested === 'user' ? null : input.sessionId?.trim() || null
    // 不变式「canvas ⇒ sessionId 非空」：拿不到归属时**降级成 user 而不是留下悬空 canvas 行**
    // （悬空行在召回时 fail-closed，等于悄悄丢记忆）。降级写 source='user_explicit' 留痕。
    const scope: AgentMemoryScope = requested === 'canvas' && !sessionId ? 'user' : requested
    const record = await this.prisma.agentMemory.create({
      data: {
        userId: input.userId,
        scope,
        sessionId,
        source: scope === 'user' ? 'user_explicit' : 'agent_auto',
        content: content.slice(0, MEMORY_CONTENT_MAX),
      },
    })
    return { id: record.id, createdAt: record.createdAt.toISOString(), scope, sessionId }
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
    sessionId?: string
    scope?: AgentMemoryScopeFilter
  }): Promise<{ items: AgentMemoryItem[] }> {
    const query = (input.query ?? '').trim()
    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.floor(input.limit) : MEMORY_RECALL_DEFAULT
    const limit = Math.min(Math.max(rawLimit, 1), MEMORY_RECALL_MAX)
    const want: AgentMemoryScopeFilter = input.scope ?? 'any'
    const currentSession = input.sessionId?.trim() || null

    // fail-closed（spec §9 Review Focus #1）：要「本画布」却没给画布 id ⇒ 一条都不召回，
    // 绝不降级成全用户检索——那正是本次事故的形态。
    if (want === 'canvas' && !currentSession) return { items: [] }
    // where 形状保持三种：{userId} / {userId,scope} / {userId,scope,sessionId}，
    // 靠 @@index([userId, scope, sessionId]) 左前缀命中（spec §9 #4）。
    const scopeWhere =
      want === 'user' ? { scope: 'user' } : want === 'canvas' ? { scope: 'canvas', sessionId: currentSession } : {}
    const rows = await this.prisma.agentMemory.findMany({
      where: { userId: input.userId, ...scopeWhere },
      orderBy: { createdAt: 'desc' },
      // 终审 I-1：`take` 是 SQL LIMIT，tier 排序在其后的 JS 侧。若这里就按 limit 截断，
      // 「本画布但更旧」的记忆会在 SQL 阶段被切掉，JS 再排也救不回来 ⇒ 本画布上下文全丢、
      // 反而只剩别画布的。所以只要存在「本画布优先」这个排序目标（有当前画布且非仅 user 档），
      // 就必须扫满窗口再排。
      take: query || (currentSession && want !== 'user') ? MEMORY_SCAN_MAX : limit,
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
    // 排序（spec §6 意图）：本画布 > 用户级偏好 > 其他画布。
    // 用户级（品牌色/暗号）是**用户显式声明的跨会话事实**，可信度高于别的画布的情节记忆；
    // 跨画布条目排最后是本次事故的直接止血——它最容易被误当成当前画布的观察结果。
    // 同档内保持 findMany 的 createdAt 倒序（稳定排序，审计 #7 的 score 序不受影响）。
    const items = matched
      .map((m, i) => ({ m, i }))
      .sort((a, b) => tier(a.m, currentSession) - tier(b.m, currentSession) || a.i - b.i)
      .slice(0, limit)
      .map(({ m }) => ({
        id: m.id,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        scope: m.scope,
        sessionId: m.sessionId ?? null,
        // 没有当前画布可比时不判定跨画布（不误标）；scope='user' 是显式跨会话偏好，不算跨画布。
        crossCanvas: m.scope === 'canvas' && !!currentSession && (m.sessionId ?? null) !== currentSession,
      }))
    return { items }
  }
}
