import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { markSuppressed } from './memory-suppression'

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
 * Phase 1（spec 2026-10-08-pilnk-memory-product-adoption-scope.md 项 A）：
 * per-(userId, scope) 记忆条数配额，超限触发 LRU 驱逐（防单用户记忆无限膨胀）。
 * 字符/token 总量配额需新增字段，留待 Phase 2 评估；本阶段以条数护栏达成"防淹没"核心目标。
 */
export const MEMORY_QUOTA_CANVAS = 500
export const MEMORY_QUOTA_USER = 100

/**
 * Phase 1（项 E）：召回字符预算硬截（近似 token 预算，零依赖、可观测）。
 * 6000 字 ≈ 1500–2000 token 量级（中文 1 字 ≈ 1–2 token）；按 tier 排序后在低相关尾部截断，
 * 不降相关度。后续可替换为 tokenizer 精确值。
 */
export const MEMORY_RECALL_CHAR_BUDGET = 6000

/**
 * Phase 2（项 B/C）：策展蒸馏与写入去重的触发/封顶参数。
 * - 写超阈值自动触发一次策展（canvas scope 原始条数穿越点）。
 * - 每个 (userId, scope) 最多保留的策展摘要条数。
 */
export const MEMORY_CONSOLIDATE_THRESHOLD = 50
export const MEMORY_CURATED_MAX = 10

/** 策展摘要溯源标记：原始行不删，标记内嵌被策展的原始 id，召回据此排除原始、保留可回溯。 */
const CONSOLIDATED_MARKER_RE = /(?:^|\n)---\s*策展自\s*(\d+)\s*条原始记忆\s*\(ids:\s*([\w,]+)\)\s*---/
function buildConsolidatedMarker(n: number, ids: string[]): string {
  return `\n--- 策展自 ${n} 条原始记忆 (ids: ${ids.join(',')}) ---`
}
function parseConsolidatedIds(content: string): string[] {
  const m = content.match(CONSOLIDATED_MARKER_RE)
  if (!m) return []
  return m[2].split(',').filter(Boolean)
}
function stripConsolidatedMarker(content: string): string {
  return content.replace(CONSOLIDATED_MARKER_RE, '').trim()
}

/**
 * 记忆作用域（spec 2026-10-03-agent-memory-scope-isolation-design.md §3.1）。
 * - canvas：仅本画布可见，`sessionId`（= Session.id）必填，`save_memory` 默认写这里
 * - user：该用户全部画布可见，只有显式 `scope:'user'` 才写这里（偏好/品牌/暗号）
 * 保持只有两个字面量，不加第三种（YAGNI）。
 */
export type AgentMemoryScope = 'canvas' | 'user'

/** 召回时的作用域过滤；'any' = 不限（跨画布条目靠 crossCanvas 标记自曝，不静默丢弃）。 */
export type AgentMemoryScopeFilter = AgentMemoryScope | 'any'

// ── M6b：晋升候选队列（spec docs/superpowers/specs/2026-10-06-memory-promotion-m6b-design.md §2.1） ──

/** 进候选池的重复次数阈值（§13.3 拍板：同一画布内重复出现 ≥3 次）。 */
export const PROMOTION_REPEAT_THRESHOLD = 3
/** 候选扫描窗口：canvas 行的 SQL LIMIT。记忆表增速低（agent_auto 每轮至多几条），
 * 5000 行窗口 + JS 聚合在 SQLite 上足够；超限在响应标注 truncated，不静默。 */
export const PROMOTION_SCAN_MAX = 5000
/** 候选默认返回条数（count 降序取最热）。 */
export const PROMOTION_CANDIDATES_LIMIT = 20
/** 原文样本截断长度（响应给人工判读用，不是给模型——长内容没必要全量出）。 */
const SAMPLE_CONTENT_MAX = 120

/**
 * 归一化：只做**无损**的字面归一（trim → 折叠空白 → 小写 → 反复剥离尾部标点），
 * 不做任何语义处理。判据是「字面重复」——§13.3 拒绝了关键词判据（一次性项目名会被误提），
 * 同理近义改写也不许合并：误晋升的成本是全量用户 × 每轮静态段，宁漏勿错。
 */
export function normalizeMemoryContent(content: string): string {
  const tailPunct = /[。.！!？?；;，,、]+$/
  return content
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(tailPunct, '')
}

/** 晋升候选：聚合后的一条（只出事实，不做 §13.3 的三级分级——分级需要人读内容）。 */
export interface PromotionCandidate {
  sessionId: string
  /** 归一化后的聚合键（判读原文看 sampleContents）。 */
  normalizedContent: string
  count: number
  firstSeenAt: string
  lastSeenAt: string
  /** 全部成员行 id——抑制标记 / 核对用。 */
  memoryIds: string[]
  /** 原文样本（按 createdAt 新→旧取 ≤3 条，截断到 120 字）。 */
  sampleContents: string[]
}

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
    // A：写前按 scope 配额 LRU 驱逐最旧（fail-soft，异常不阻断写入）
    const quota = scope === 'user' ? MEMORY_QUOTA_USER : MEMORY_QUOTA_CANVAS
    // 配额计数也 fail-soft：失败则视为 0（跳过驱逐，不阻断写入——恢复 Phase1 已锁的 fail-soft 判据）
    let total = 0
    try { total = await this.prisma.agentMemory.count({ where: { userId: input.userId, scope } }) } catch { /* fail-soft */ }
    await this.evictIfOverQuota(input.userId, scope, quota, total)
    // C 写入去重：同 (userId, scope, sessionId) 内字面重复 ⇒ 更新而非新增（消除"小熊×13"类重复）
    const norm = normalizeMemoryContent(content)
    const dup = await this.findDuplicate(input.userId, scope, sessionId, norm)
    let record
    if (dup) {
      record = await this.prisma.agentMemory.update({
        where: { id: dup.id },
        data: { content: content.slice(0, MEMORY_CONTENT_MAX) },
      })
    } else {
      record = await this.prisma.agentMemory.create({
        data: {
          userId: input.userId,
          scope,
          sessionId,
          source: scope === 'user' ? 'user_explicit' : 'agent_auto',
          content: content.slice(0, MEMORY_CONTENT_MAX),
        },
      })
    }
    // B 自动触发：canvas scope 原始越过阈值时跑一次策展（阈值穿越点触发，频率有界；fail-soft）
    if (scope === 'canvas' && total + 1 > MEMORY_CONSOLIDATE_THRESHOLD) {
      try { await this.consolidateMemory({ userId: input.userId, scope }) } catch { /* fail-soft */ }
    }
    return { id: record.id, createdAt: record.createdAt.toISOString(), scope, sessionId }
  }

  /**
   * A 配额驱逐（spec 项 A）：写前若 (userId, scope) 已超配额，按 createdAt 最旧删除超额部分。
   * 软约束（非事务）：配额是"防膨胀护栏"而非硬锁，并发下短暂超一点可接受。
   * fail-soft：驱逐链路任何异常都只跳过驱逐、不阻断本次写入（记忆不能因护栏失效而丢失）。
   */
  private async evictIfOverQuota(userId: string, scope: AgentMemoryScope, quota: number, currentCount?: number): Promise<void> {
    try {
      const count = currentCount ?? (await this.prisma.agentMemory.count({ where: { userId, scope } }))
      const excess = count + 1 - quota
      if (excess <= 0) return
      const oldest = await this.prisma.agentMemory.findMany({
        where: { userId, scope },
        orderBy: { createdAt: 'asc' },
        take: excess,
        select: { id: true },
      })
      if (oldest.length) {
        await this.prisma.agentMemory.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } })
      }
    } catch {
      // 驱逐失败不阻断写入：配额护栏是软约束，宁可少驱逐也不让 save 抛错
    }
  }

  /**
   * C 写入去重（spec 项 C）：在 (userId, scope, sessionId) 内按归一化内容查重，命中返回该行（供 update）。
   * 只做字面去重（规格 C 非目标：不做语义级）；fail-soft：异常返回 null（退化为新增，不丢记忆）。
   */
  private async findDuplicate(userId: string, scope: AgentMemoryScope, sessionId: string | null, norm: string): Promise<{ id: string } | null> {
    try {
      const rows = await this.prisma.agentMemory.findMany({
        where: { userId, scope, sessionId, source: { not: 'curated' } },
        select: { id: true, content: true },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      })
      const hit = rows.find((r) => normalizeMemoryContent(r.content) === norm)
      return hit ? { id: hit.id } : null
    } catch {
      return null
    }
  }

  /**
   * B 策展蒸馏（spec 项 B，规则合并、无 LLM）：仅 canvas scope 内、按 sessionId 保守聚类，
   * 把同会话 ≥2 条原始记忆合并为 1 条 `source='curated'` 摘要（取最新 3 条原文拼接）。
   * 原始行**保留不删**（content 末尾内嵌 consolidatedFrom 溯源标记），召回时排除被策展原始行、优先返回摘要。
   * 幂等：已策展引用的原始 id 不再重复策展；封顶 MEMORY_CURATED_MAX 条/ scope。fail-soft：异常返回 {created:0}。
   */
  async consolidateMemory(input: { userId: string; scope: AgentMemoryScope }): Promise<{ created: number }> {
    if (input.scope !== 'canvas') return { created: 0 } // 保守：user 偏好不策展，避免误并
    try {
      const { userId, scope } = input
      const existing = await this.prisma.agentMemory.findMany({
        where: { userId, scope, source: 'curated' },
        select: { content: true },
      })
      const already = new Set<string>()
      for (const c of existing) for (const id of parseConsolidatedIds(c.content)) already.add(id)
      const raws = await this.prisma.agentMemory.findMany({
        where: { userId, scope, source: { not: 'curated' } },
        orderBy: { createdAt: 'asc' },
        take: 5000,
      })
      const groups = new Map<string, typeof raws>()
      for (const r of raws) {
        if (already.has(r.id)) continue
        const key = r.sessionId ?? ''
        const arr = groups.get(key)
        if (arr) arr.push(r)
        else groups.set(key, [r])
      }
      let created = 0
      let curated = existing.length
      for (const members of groups.values()) {
        if (curated >= MEMORY_CURATED_MAX) break
        if (members.length < 2) continue
        members.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) // 显式升序，取最新 3 条，不依赖查序
        const ids = members.map((m) => m.id)
        const marker = buildConsolidatedMarker(members.length, ids)
        const cap = MEMORY_CONTENT_MAX - marker.length
        const reps = members.slice(-3).map((m) => m.content.slice(0, 200)).join('；')
        const summary = (reps.length > cap ? reps.slice(0, cap) : reps) + marker
        await this.prisma.agentMemory.create({
          data: { userId, scope, sessionId: members[0].sessionId, source: 'curated', content: summary },
        })
        created++
        curated++
      }
      return { created }
    } catch {
      return { created: 0 }
    }
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
  }): Promise<{ items: AgentMemoryItem[]; truncated: boolean }> {
    const query = (input.query ?? '').trim()
    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.floor(input.limit) : MEMORY_RECALL_DEFAULT
    const limit = Math.min(Math.max(rawLimit, 1), MEMORY_RECALL_MAX)
    const want: AgentMemoryScopeFilter = input.scope ?? 'any'
    const currentSession = input.sessionId?.trim() || null

    // fail-closed（spec §9 Review Focus #1）：要「本画布」却没给画布 id ⇒ 一条都不召回，
    // 绝不降级成全用户检索——那正是本次事故的形态。
    if (want === 'canvas' && !currentSession) return { items: [], truncated: false }
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
    // B：从 curated 行解析被策展的原始 id，召回时排除这些原始行（原始仍在库，可回溯）；curated 行本身保留。
    const consolidatedFrom = new Set<string>()
    for (const r of rows) {
      if (r.source === 'curated') for (const id of parseConsolidatedIds(r.content)) consolidatedFrom.add(id)
    }
    const filtered = rows.filter((r) => r.source === 'curated' || !consolidatedFrom.has(r.id))
    // 分词打分召回（审计 #7）：OR 命中 + 计分（全 token 命中的排前），零分过滤。
    // % / _ 天然按普通子串处理（不是 LIKE，Review I-2 语义保持）；同分保持
    // findMany 的 createdAt 倒序（Array.prototype.sort 稳定排序）。
    let matched: typeof filtered
    if (!query) {
      matched = filtered
    } else {
      const tokens = this.tokenize(query)
      const scored = filtered
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
    const limited = matched
      .map((m, i) => ({ m, i }))
      .sort((a, b) => tier(a.m, currentSession) - tier(b.m, currentSession) || a.i - b.i)
      .slice(0, limit)
    // E: recall char-budget hard cap (spec item E). Truncate low-relevance tail after tier sort; never drop relevance.
    // First entry is always kept (budgeted empty => no cap) so at least one result returns.
    let used = 0
    let truncated = false
    const budgeted: typeof limited = []
    for (const entry of limited) {
      const len = entry.m.content.length
      if (budgeted.length > 0 && used + len > MEMORY_RECALL_CHAR_BUDGET) {
        truncated = true
        break
      }
      budgeted.push(entry)
      used += len
    }
    const items = budgeted
      .map(({ m }) => ({
        id: m.id,
        content: stripConsolidatedMarker(m.content),
        createdAt: m.createdAt.toISOString(),
        scope: m.scope,
        sessionId: m.sessionId ?? null,
        // 没有当前画布可比时不判定跨画布（不误标）；scope='user' 是显式跨会话偏好，不算跨画布。
        crossCanvas: m.scope === 'canvas' && !!currentSession && (m.sessionId ?? null) !== currentSession,
      }))
    return { items, truncated }
  }

  /**
   * M6b 晋升候选队列（spec §2.1）：canvas 行按 (sessionId, 归一化内容) 聚合，重复 ≥3 进候选。
   *
   * - 只扫 `scope='canvas'`（§13.3：用户偏好不晋升；项目事实/行为纠正类默认落 canvas），
   *   且排除 `source='promoted'`——晋升落库的审计行不得再次进候选（否则队列永远显示已处理条目）。
   * - **只出事实不做分级**：§13.3 的三级分级（偏好不升 / 事实进 user 档 / 纠正进 core 组）
   *   需要人读内容才能判，端点做不了也不该做。
   * - 扫描窗口封顶 PROMOTION_SCAN_MAX，超限在响应标注 truncated（不静默截断——
   *   静默丢窗口会让人误以为「没有更多重复」）。
   * - 队列是只读视图；晋升动作本身走 PR（6 处同步 + prompt:lint），见 docs/ops/memory-m6b-runbook.md。
   */
  async promotionCandidates(input: {
    userId: string
    minCount?: number
    limit?: number
  }): Promise<{ candidates: PromotionCandidate[]; scannedRows: number; threshold: number; truncated: boolean }> {
    const threshold = input.minCount && input.minCount >= 1 ? Math.floor(input.minCount) : PROMOTION_REPEAT_THRESHOLD
    const limit = input.limit && input.limit >= 1 ? Math.min(Math.floor(input.limit), 100) : PROMOTION_CANDIDATES_LIMIT
    const rows = await this.prisma.agentMemory.findMany({
      where: { userId: input.userId, scope: 'canvas', source: { not: 'promoted' } },
      orderBy: { createdAt: 'desc' },
      take: PROMOTION_SCAN_MAX,
    })
    const truncated = rows.length >= PROMOTION_SCAN_MAX
    const groups = new Map<string, {
      sessionId: string
      normalizedContent: string
      members: { id: string; at: string }[]
      firstSeenAt: string
      lastSeenAt: string
      samples: string[]
    }>()
    for (const r of rows) {
      const key = `${r.sessionId ?? ''}\u0000${normalizeMemoryContent(r.content)}`
      let g = groups.get(key)
      if (!g) {
        g = { sessionId: r.sessionId ?? '', normalizedContent: normalizeMemoryContent(r.content), members: [], firstSeenAt: '', lastSeenAt: '', samples: [] }
        groups.set(key, g)
      }
      const at = r.createdAt.toISOString()
      g.members.push({ id: r.id, at })
      if (!g.firstSeenAt || at < g.firstSeenAt) g.firstSeenAt = at
      if (at > g.lastSeenAt) g.lastSeenAt = at
      // 样本按原文去重：字面重复的成员出 N 条同文没有判读价值
      if (g.samples.length < 3 && !g.samples.includes(r.content.slice(0, SAMPLE_CONTENT_MAX))) {
        g.samples.push(r.content.slice(0, SAMPLE_CONTENT_MAX))
      }
    }
    const candidates = [...groups.values()]
      .filter((g) => g.members.length >= threshold)
      .sort((a, b) => b.members.length - a.members.length || (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0))
      .slice(0, limit)
      .map((g) => ({
        sessionId: g.sessionId,
        normalizedContent: g.normalizedContent,
        count: g.members.length,
        firstSeenAt: g.firstSeenAt,
        lastSeenAt: g.lastSeenAt,
        // 稳定契约：成员按 createdAt 升序（首见在前）——SQL 返回是 desc，直接透传顺序不稳定
        memoryIds: [...g.members].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((m) => m.id),
        sampleContents: g.samples,
      }))
    return { candidates, scannedRows: rows.length, threshold, truncated }
  }

  /**
   * M6b 抑制标记入口（spec §2.2）：人工确认后经由本方法下发抑制。
   *
   * 链路：归属校验 → Nest 侧进程内表（注入通道**立即生效**）→ fail-soft 转发
   * pi-runtime `/internal/memory-suppress`（recall_memory 通道）。
   *
   * 为什么归属校验是 404 而不是 403：暴露「这条 id 存在但不属于你」本身就是信息泄露，
   * 与 sessions 的既有处理一致（不存在与不属于同态）。
   * 为什么转发失败不报错：主污染通道是每轮自动注入（Nest 侧），Nest 标记已生效；
   * recall_memory 通道缺失是可接受降级，如实回报 forwarded 供调用方判断。
   */
  async suppressMemory(input: { userId: string; memoryId: string; reason: string }): Promise<{ forwarded: boolean }> {
    const memoryId = (input.memoryId ?? '').trim()
    if (!memoryId) throw new BadRequestException('memoryId required')
    const row = await this.prisma.agentMemory.findUnique({ where: { id: memoryId } })
    if (!row || row.userId !== input.userId) throw new NotFoundException('memory not found')
    markSuppressed(memoryId, (input.reason ?? '').trim() || 'unspecified')
    return { forwarded: await this.forwardSuppression(memoryId, (input.reason ?? '').trim()) }
  }

  /** 转发到 pi-runtime 内部端点；任何失败（未配置/超时/非 2xx）都只降级为 forwarded:false。 */
  private async forwardSuppression(memoryId: string, reason: string): Promise<boolean> {
    // 与 agent.service.ts 的 runtimeUrl 同源（PI_RUNTIME_URL，运行时读取而非启动快照）
    const runtimeUrl = process.env.PI_RUNTIME_URL?.trim() || undefined
    if (!runtimeUrl) return false
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 3000)
      try {
        const res = await fetch(`${runtimeUrl.replace(/\/$/, '')}/internal/memory-suppress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ memoryId, reason }),
          signal: ac.signal,
        })
        return res.ok
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    }
  }
}
