#!/usr/bin/env tsx
/**
 * 存量助手消息 content 清洗（一次性运维脚本，dry-run 默认）。
 *
 * 背景：Q2 修复（PR #121，mergeCommit a561d2d）只在 `finalizeTurn` 落库这一跳
 * 归一化首尾空行，**只挡新写入的消息**。生产库里修复上线前就存在的脏行不会被
 * 追溯清理 —— 生产取证（2026-10-03）：assistant 消息 10199 条里首部空白 283 条
 * （2.77%）、尾部空白 89 条；其中 205 条剥后有正文，78 条剥后全空。
 *
 * 用法（生产容器内）：
 *   # 1) 先看清洗计划（不写库）
 *   docker exec -i lnkpi-api sh -c 'cd /app/apps/server && node_modules/.bin/tsx /app/scripts/clean-message-content.ts'
 *   # 2) 确认无误后写库
 *   docker exec -i lnkpi-api sh -c '... --apply'
 *   # 3) 限定会话（可选，出事时缩小爆炸半径）
 *   docker exec -i lnkpi-api sh -c '... --apply --session=cmurxxxxxxxx'
 *
 * 安全约束（与 backfill-memory-scope 一致）：
 * - dry-run 是默认，必须显式 --apply 才写
 * - 写库前自动备份 *.db（同目录 .bak-<ts>）
 * - 行数守恒断言：**不删任何行**（剥完为空的行 content 置空串），条数必须恒等
 * - 幂等：normalize 是幂等的，已清洗的行产出 0 变更，可安全重跑
 * - 复用 `normalizeAssistantText`——清洗规则与写入路径同一份实现，
 *   杜绝「清洗脚本一套正则、写入路径另一套」导致的正文改坏
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { planContentCleanup, type CleanupCandidateRow } from '../apps/server/src/agent/message-content-cleanup.js'
import { normalizeAssistantText } from '../apps/server/src/agent/text-normalize.js'

const APPLY = process.argv.includes('--apply')
const SESSION = process.argv.find((a) => a.startsWith('--session='))?.slice('--session='.length)

/** AgentMessage.metadata 是 Prisma Json，落库后可能是 string（历史 JSON.stringify） */
type Meta = {
  executionEvents?: unknown[]
  presentation?: unknown
} | null

function parseMeta(raw: unknown): Meta {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Meta
    } catch {
      // 解析失败按「无载荷」处理——只影响分类展示，不影响是否清洗 content
      return null
    }
  }
  return raw as Meta
}

type Row = {
  id: string
  sessionId: string
  content: string
  toolCalls: string | null
  metadata: unknown
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const where = SESSION ? { sessionId: SESSION } : {}
    const rows = (await prisma.agentMessage.findMany({
      where: { role: 'assistant', ...where },
      orderBy: { createdAt: 'desc' },
    })) as Row[]

    const candidates: CleanupCandidateRow[] = rows.map((r) => {
      const meta = parseMeta(r.metadata)
      return {
        id: r.id,
        content: typeof r.content === 'string' ? r.content : String(r.content ?? ''),
        hasExecutionEvents: Array.isArray(meta?.executionEvents) && meta.executionEvents.length > 0,
        hasPresentation: Boolean(meta?.presentation),
        hasToolCalls: Boolean(r.toolCalls),
      }
    })

    const plan = planContentCleanup(candidates)
    const byId = new Map(candidates.map((c) => [c.id, c]))

    console.log(
      `[clean-content] assistant 消息 ${plan.total} 条｜范围=${SESSION ?? '全部'}｜` +
        `待清洗 ${plan.changed}（置空 ${plan.toEmpty} / 改正文 ${plan.toText} / 删行 ${plan.dropped}）｜` +
        `模式=${APPLY ? 'APPLY（会写库）' : 'DRY-RUN（不写库）'}`,
    )

    // 载荷分布：解释「剥完为空的行」为什么不能删
    const emptyWithPayload = plan.ids.filter((id) => {
      const c = byId.get(id)
      if (!c) return false
      const next = normalizeAssistantText(c.content)
      return next.length === 0 && (c.hasExecutionEvents || c.hasPresentation || c.hasToolCalls)
    }).length
    console.log(
      `[clean-content] 剥完为空且带 payload（executionEvents/presentation/toolCalls）的行：${emptyWithPayload}` +
        ` —— 这些行保留，只把 content 置空（删行= 丢思考链/工具轨迹）`,
    )

    if (!APPLY) {
      console.log('[clean-content] DRY-RUN 结束，未写库。确认后加 --apply。')
      return
    }
    if (plan.changed === 0) {
      console.log('[clean-content] 无需清洗，幂等命中，直接结束。')
      return
    }

    // 写库前备份
    const dbPath = process.env.DATABASE_URL?.replace(/^file:/, '') || '/app/apps/server/data/lnkpi.db'
    const resolved = existsSync(dbPath) ? dbPath : join('/app/apps/server/data', 'lnkpi.db')
    const bak = `${resolved}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(resolved, bak)
    console.log(`[clean-content] 已备份 ${resolved} → ${bak}`)

    // 逐行 update：只改 content，不动其他列
    let written = 0
    for (const id of plan.ids) {
      const c = byId.get(id)
      if (!c) continue
      await prisma.agentMessage.update({
        where: { id },
        data: { content: normalizeAssistantText(c.content) },
      })
      written++
    }

    // 行数守恒断言：不删行 ⇒ 前后条数必须相等
    const after = await prisma.agentMessage.count({ where: { role: 'assistant', ...where } })
    if (after !== rows.length) {
      throw new Error(`行数不守恒：清洗前 ${rows.length} → 清洗后 ${after}`)
    }

    console.log(
      `[clean-content] 写入 ${written} 行｜行数守恒 ${rows.length} → ${after} ✓｜备份 ${bak}`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error('[clean-content] 失败：', e)
  process.exit(1)
})
