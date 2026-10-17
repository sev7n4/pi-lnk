#!/usr/bin/env tsx
/**
 * 历史重复回合软标记（一次性运维脚本，dry-run 默认）。
 *
 * 背景：PR1/PR2（#437/#438）在**写入路径**上掐掉了「同一 run 被多次落库」与
 * 「409→shadow 不落库」，但**生产库里修复上线前就已存在的重复回合**不会被追溯清理。
 * 这类重复表现为：同一逻辑回合（同 threadId）被持久化为多条 assistant AgentMessage
 * 行（写链绑定 / 提议卡漂移等历史 bug 所致）。
 *
 * 本脚本**只做软标记、不物理删除**：
 * - 影子行（重复中较小的 / 较早被取代的）写 `metadata.supersededBy = ownerId`；
 * - 影子行的 `linkedOutputs` 去重合并进 owner 行；
 * - 读取出口（agent.service.getMessages）据此过滤，被取代行不再展示。
 * 观察 1–2 周、抽样确认无误后再议是否物理清理。
 *
 * 判定（保守，宁放过不误杀）：同 threadId 内，两条 assistant 行 A/B 当且仅当
 *   1) 事件集合可比：A.events ⊆ B.events 或 B.events ⊆ A.events（用 type+data 指纹，
 *      刻意排除 seq/ts/messageIndex——落库 seq 是本地序，不可用作身份；
 *      ts/messageIndex 是时序/位置量，亦不进身份）；
 *   2) 正文一致：normalize(A.content) 是 normalize(B.content) 的子串/前缀或相等
 *      （任一侧无正文视为一致，兼容「仅 thinking/工具、无正文」的合法回合）。
 * 满足条件的行聚成连通分量；分量内**事件集最大者（被其余所有行包含）**为 owner，
 * 其余为影子。若分量内无单一最大者（如 A⊆B、A⊆C 但 B/C 不可比）→ 整组不动。
 *
 * 用法（生产容器内）：
 *   # 1) 看计划（不写库）
 *   docker exec -i lnkpi-api sh -c 'cd /app/apps/server && node_modules/.bin/tsx /app/scripts/repair-duplicate-turns.ts'
 *   # 2) 限定会话（先小范围验证，缩小爆炸半径）
 *   docker exec -i lnkpi-api sh -c '... --session=cmv9hmpph001qoa017y9rv312'
 *   # 3) 确认无误后写库
 *   docker exec -i lnkpi-api sh -c '... --apply'
 *   # 4) 导出待人工抽样清单
 *   docker exec -i lnkpi-api sh -c '... --apply --manifest=/app/repair-manifest.json'
 *
 * 安全约束（同 clean-message-content.ts）：
 * - dry-run 是默认，必须显式 --apply 才写；
 * - 写库前自动备份 *.db；
 * - 行数守恒断言：绝不删除行（只改 metadata / linkedOutputs）；
 * - 幂等：已带 supersededBy 的行直接跳过，可安全重跑；
 * - 不触碰 user 行。
 *
 * 黄金样本：本画布 cmv9hmpph001qoa017y9rv312 的 3 条已知重复回合，
 * 应在全量验证通过后**最后**单独用 --session 处理并人工复核。
 */
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const APPLY = process.argv.includes('--apply')
const SESSION = process.argv.find((a) => a.startsWith('--session='))?.slice('--session='.length)
const MANIFEST = process.argv.find((a) => a.startsWith('--manifest='))?.slice('--manifest='.length)

// ---- 类型（脚本内联，避免引入 shared 包路径耦合；与 Prisma Json 列一致）----
type ExecEvent = { type: string; data: unknown; seq?: number; ts?: number; messageIndex?: number }
type LinkedCanvasOutput = { nodeId: string; title?: string; nodeType?: string; status?: string }
type Meta = {
  executionEvents?: ExecEvent[]
  supersededBy?: string
  partial?: boolean
  [k: string]: unknown
} | null

interface SigRow {
  id: string
  threadId: string
  createdAt: Date
  content: string
  eventKeys: Set<string>
  eventsLen: number
  linkedOutputs: LinkedCanvasOutput[]
  meta: Meta
}

interface Group {
  threadId: string
  owner: SigRow
  shadows: SigRow[]
  mergedLinkedOutputs: LinkedCanvasOutput[]
}

interface RawRow {
  id: string
  threadId: string
  createdAt: Date
  content: string
  linkedOutputs: string | null
  metadata: string | null
}

// ---- 工具 ----
function parseMeta(raw: unknown): Meta {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Meta
    } catch {
      return null
    }
  }
  return raw as Meta
}

/** 比较专用归一化（仅用于子集/前缀判定，不写库）：去首尾空白、折叠 2+ 连续空行。 */
function normalizeForCompare(s: string): string {
  return (s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') +
    '}'
  )
}

function hashStable(v: unknown): string {
  return createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 16)
}

/** 事件身份键集合：type + data 指纹，刻意排除 seq/ts/messageIndex（非身份）。 */
function eventKeySet(events?: ExecEvent[]): Set<string> {
  const set = new Set<string>()
  for (const e of events ?? []) set.add(`${e.type}::${hashStable(e.data)}`)
  return set
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false
  return true
}

function contentConsistent(a: string, b: string): boolean {
  const na = normalizeForCompare(a)
  const nb = normalizeForCompare(b)
  if (na.length === 0 || nb.length === 0) return true // 任一侧无正文 ⇒ 不矛盾
  return na.includes(nb) || nb.includes(na)
}

/** A/B 是否为同一回合的重复候选。 */
function isDuplicatePair(a: SigRow, b: SigRow): boolean {
  if (!isSubset(a.eventKeys, b.eventKeys) && !isSubset(b.eventKeys, a.eventKeys)) return false
  return contentConsistent(a.content, b.content)
}

/** 并查集（用于把重复候选聚成连通分量）。 */
class UnionFind {
  private parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }
  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b)
  }
}

/**
 * 在一个 thread 的 assistant 行中找出重复组。
 * owner = 事件集被分量内其余所有行包含者（在 ⊆ 关系下为全序，最大者唯一）；
 * 找不到单一最大者 ⇒ 返回空（整组不动，宁放过不误杀）。
 */
function findGroups(rows: SigRow[], threadId: string): Group[] {
  const active = rows.filter((r) => !r.meta?.supersededBy) // 幂等：跳过已处理
  const n = active.length
  if (n < 2) return []

  const uf = new UnionFind(n)
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (isDuplicatePair(active[i], active[j])) uf.union(i, j)

  const comps = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = uf.find(i)
    if (!comps.has(r)) comps.set(r, [])
    comps.get(r)!.push(i)
  }

  const groups: Group[] = []
  for (const idxs of comps.values()) {
    if (idxs.length < 2) continue
    // 创建早者优先：让「首个被持久化的回合」成为 owner
    const members = idxs.map((i) => active[i]).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    let owner: SigRow | null = null
    for (const m of members) {
      const dominates = members.every((o) => isSubset(o.eventKeys, m.eventKeys))
      if (dominates) {
        owner = m
        break
      }
    }
    if (!owner) continue // 无单一最大者 ⇒ 整组不动

    const shadows = members.filter((m) => m !== owner)
    const merged: LinkedCanvasOutput[] = []
    const seen = new Set<string>()
    const pushAll = (arr?: LinkedCanvasOutput[]) => {
      for (const o of arr ?? []) {
        if (!o.nodeId || seen.has(o.nodeId)) continue
        seen.add(o.nodeId)
        merged.push(o)
      }
    }
    pushAll(owner.linkedOutputs)
    for (const s of shadows) pushAll(s.linkedOutputs)

    groups.push({ threadId, owner, shadows, mergedLinkedOutputs: merged })
  }
  return groups
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const where = SESSION ? { role: 'assistant', sessionId: SESSION } : { role: 'assistant' }
    const rowsRaw = (await prisma.agentMessage.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: { id: true, threadId: true, createdAt: true, content: true, linkedOutputs: true, metadata: true },
    })) as unknown as RawRow[]

    const byThread = new Map<string, SigRow[]>()
    for (const r of rowsRaw) {
      const meta = parseMeta(r.metadata)
      let linked: LinkedCanvasOutput[] = []
      if (r.linkedOutputs) {
        try {
          linked = JSON.parse(r.linkedOutputs) as LinkedCanvasOutput[]
        } catch {
          linked = []
        }
      }
      const events = meta?.executionEvents as ExecEvent[] | undefined
      const sig: SigRow = {
        id: r.id,
        threadId: r.threadId,
        createdAt: r.createdAt,
        content: typeof r.content === 'string' ? r.content : String(r.content ?? ''),
        eventKeys: eventKeySet(events),
        eventsLen: events?.length ?? 0,
        linkedOutputs: linked,
        meta,
      }
      if (!byThread.has(r.threadId)) byThread.set(r.threadId, [])
      byThread.get(r.threadId)!.push(sig)
    }

    const allGroups: Group[] = []
    for (const [threadId, rows] of byThread) allGroups.push(...findGroups(rows, threadId))

    const shadowCount = allGroups.reduce((s, g) => s + g.shadows.length, 0)
    console.log(
      `[repair-dup] assistant 行 ${rowsRaw.length}｜thread ${byThread.size}｜` +
        `命中重复组 ${allGroups.length}｜影子行 ${shadowCount}｜` +
        `范围=${SESSION ?? '全部'}｜模式=${APPLY ? 'APPLY（写库）' : 'DRY-RUN（不写库）'}`,
    )
    for (const g of allGroups) {
      console.log(
        `  组 thread=${g.threadId} owner=${g.owner.id}(events=${g.owner.eventsLen}) ` +
          `shadows=[${g.shadows.map((s) => `${s.id}(events=${s.eventsLen})`).join(', ')}] ` +
          `mergedOutputs=${g.mergedLinkedOutputs.length}`,
      )
    }

    if (MANIFEST) {
      const payload = allGroups.map((g) => ({
        threadId: g.threadId,
        ownerId: g.owner.id,
        ownerCreatedAt: g.owner.createdAt,
        ownerEventCount: g.owner.eventsLen,
        shadowIds: g.shadows.map((s) => ({ id: s.id, createdAt: s.createdAt, eventCount: s.eventsLen })),
        mergedLinkedOutputCount: g.mergedLinkedOutputs.length,
      }))
      writeFileSync(MANIFEST, JSON.stringify(payload, null, 2))
      console.log(`[repair-dup] 清单已写 ${MANIFEST}（${payload.length} 组）`)
    }

    if (!APPLY) {
      console.log('[repair-dup] DRY-RUN 结束，未写库。确认后加 --apply。')
      return
    }
    if (allGroups.length === 0) {
      console.log('[repair-dup] 无重复，幂等命中，结束。')
      return
    }

    // 写前备份
    const dbPath = process.env.DATABASE_URL?.replace(/^file:/, '') || '/app/apps/server/data/lnkpi.db'
    const resolved = existsSync(dbPath) ? dbPath : join('/app/apps/server/data', 'lnkpi.db')
    const bak = `${resolved}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(resolved, bak)
    console.log(`[repair-dup] 已备份 ${resolved} → ${bak}`)

    let written = 0
    for (const g of allGroups) {
      if (g.mergedLinkedOutputs.length) {
        await prisma.agentMessage.update({
          where: { id: g.owner.id },
          data: { linkedOutputs: JSON.stringify(g.mergedLinkedOutputs) },
        })
        written++
      }
      for (const s of g.shadows) {
        const m = { ...(s.meta || {}) } as Meta
        m.supersededBy = g.owner.id
        await prisma.agentMessage.update({
          where: { id: s.id },
          data: { metadata: JSON.stringify(m) },
        })
        written++
      }
    }

    // 行数守恒断言：不删行 ⇒ 前后条数必须相等
    const after = await prisma.agentMessage.count({ where })
    if (after !== rowsRaw.length) {
      throw new Error(`行数不守恒：修复前 ${rowsRaw.length} → 修复后 ${after}`)
    }
    console.log(
      `[repair-dup] 写入 ${written} 次更新｜行数守恒 ${rowsRaw.length} → ${after} ✓｜备份 ${bak}`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error('[repair-dup] 失败：', e)
  process.exit(1)
})
