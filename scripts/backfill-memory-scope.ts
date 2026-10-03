#!/usr/bin/env tsx
/**
 * 记忆作用域回填（一次性运维脚本，dry-run 默认）。
 * spec: docs/superpowers/specs/2026-10-03-agent-memory-scope-isolation-design.md §7
 *
 * 背景：迁移把 `agent_memories.scope` 默认成 'user'（保旧行为、可秒级回滚），
 * 所以上线后存量记忆**仍然跨画布可召回**——本次事故的形态还在。本脚本负责收紧：
 * 凭据/偏好留user 层，明确的项目知识降到对应画布。
 *
 * 用法（生产容器内）：
 *   # 1) 先看分类结果（不写库）
 *   docker exec -i lnkpi-api sh -c 'cd /app/apps/server && node_modules/.bin/tsx /app/scripts/backfill-memory-scope.ts'
 *   # 2) 存量项目知识没有 sessionId（这列是本次迁移才加的），且生产 Session.title
 *   #    基本都是 layout-smoke-<ts> 噪声 ⇒ 无法自动反推归属。人工给映射后重跑：
 *   docker exec -i lnkpi-api sh -c '... --map '"'"'{"小熊和小爸爸":"cmuxxxxx"}'"'"''
 *   # 3) 确认无误后写库
 *   docker exec -i lnkpi-api sh -c '... --apply'            # 配合 --map 一起给
 *
 * 安全约束：
 * - dry-run 是默认，必须显式 --apply 才写
 * - 写库前自动备份 *.db（同目录 .bak-<ts>）
 * - 行数守恒断言：写后条数必须与写前相等（spec G4 零丢失）
 * - 映射指向不存在的画布直接抛错（不留悬空归属）
 * - 幂等：已是目标态的行不写，重复跑结果不变
 */
import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import {
  applyManualMap,
  classifyMemory,
  planBackfill,
  type BackfillTargetRow,
} from '../apps/server/src/agent/memory-scope-classify.js'

const APPLY = process.argv.includes('--apply')
const MAP_FILE = process.argv.find((a) => a.startsWith('--map-file='))?.slice('--map-file='.length)
const MAP_JSON = process.argv.find((a) => a.startsWith('--map='))?.slice('--map='.length)

function readManualMap(): Record<string, string> {
  if (MAP_FILE) return JSON.parse(readFileSync(MAP_FILE, 'utf8')) as Record<string, string>
  if (MAP_JSON) return JSON.parse(MAP_JSON) as Record<string, string>
  return {}
}

type Row = BackfillInputRow & { content: string; userId: string; createdAt: Date }

async function main() {
  const prisma = new PrismaClient()
  try {
    const rows = (await prisma.agentMemory.findMany({ orderBy: { createdAt: 'desc' } })) as Row[]
    const sessions = await prisma.session.findMany({ select: { id: true } })
    const liveSessions = new Set(sessions.map((s) => s.id))

    console.log(
      `[backfill] 记忆 ${rows.length} 条 / 画布 ${sessions.length} 个｜模式=${APPLY ? 'APPLY（会写库）' : 'DRY-RUN（不写库）'}`,
    )

    // 1) 内容分类（决定这是不是项目知识）
    const classified = rows.map((r) => ({ ...r, judged: classifyMemory(r.content) }))
    // 2) 人工映射给出画布归属（存量记忆本身没有 sessionId）
    const manual = applyManualMap(
      classified.map((r) => ({ id: r.id, content: r.content, judgedScope: r.judged.scope })),
      readManualMap(),
      liveSessions,
    )
    // 3) 归属有效性校验（画布还在吗）——项目知识 且 画布确定 且 画布存在 ⇒ canvas。
    //    ⚠️ dbScope/dbSessionId 必须是 **DB 真实值**（r.scope / r.sessionId），
    //    targetScope/targetSessionId 才是判定+映射结果。终审 C-2：两者混用会让
    //    `changed`恒为 false，`--apply` 一行都不写，目标态只存在于打印输出。
    const input: BackfillTargetRow[] = classified.map((r) => ({
      id: r.id,
      dbScope: r.scope,
      dbSessionId: r.sessionId,
      targetScope: r.judged.scope,
      targetSessionId: manual.get(r.id) ?? null,
    }))
    const plan = planBackfill(input, liveSessions)
    const byId = new Map(plan.map((p) => [p.id, p]))

    let canvas = 0
    let user = 0
    for (const r of classified) {
      const p = byId.get(r.id)!
      if (p.scope === 'canvas') canvas++
      else user++
      console.log(
        [
          p.changed ? 'CHANGE' : '  keep',
          p.scope.padEnd(6),
          (p.sessionId ?? '-').slice(0, 26).padEnd(26),
          (r.userId ?? '').padEnd(28),
          r.createdAt.toISOString().slice(0, 10),
          r.content.slice(0, 40).replace(/\n/g, ' '),
          `← ${p.reason}`,
        ].join(' '),
      )
    }
    const unmapped = classified.filter((r) => r.judged.scope === 'canvas' && !manual.has(r.id))
    if (unmapped.length) {
      console.log(
        `[backfill] 提示：${unmapped.length} 条判为项目知识但**无画布归属**（存量记忆没有 sessionId，` +
          `需--map '{"关键词":"画布id"}'），已保守留user 层。`,
      )
    }
    console.log(`[backfill] 目标态：canvas ${canvas} 条 / user ${user} 条 / 合计 ${canvas + user}（输入 ${rows.length}）`)
    if (canvas + user !== rows.length) {
      throw new Error('行数不守恒，中止（不允许丢记忆）')
    }

    const changes = plan.filter((p) => p.changed)
    if (!APPLY) {
      console.log(`[backfill] DRY-RUN 结束：${changes.length} 行待写。加 --apply 执行。`)
      return
    }
    if (changes.length === 0) {
      console.log('[backfill] 无需写入（已是目标态）。')
      return
    }

    // 写库前备份
    const dbPath = process.env.DATABASE_URL?.replace(/^file:/, '') ?? '/app/apps/server/data/lnkpi.db'
    const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const { copyFileSync } = await import('node:fs')
    copyFileSync(dbPath, backup)
    console.log(`[backfill] 已备份 ${dbPath} → ${backup}`)

    const before = rows.length
    for (const p of changes) {
      await prisma.agentMemory.update({
        where: { id: p.id },
        data: { scope: p.scope, sessionId: p.sessionId, source: 'promoted' },
      })
    }
    const after = await prisma.agentMemory.count()
    console.log(`[backfill] 写入 ${changes.length} 行；条数 ${before} → ${after}`)
    if (before !== after) throw new Error(`条数变化${before} → ${after}，请用备份回滚`)
    const byScope = await prisma.agentMemory.groupBy({ by: ['scope'], _count: { _all: true } })
    console.log('[backfill] 落库分布：' + JSON.stringify(byScope))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error('[backfill] 失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
