// scripts/verify-thread-unify.ts
/**
 * H0-b 归并校验（规格 §7.3 第 4 步 / §8 幂等判据 / 验收 S3+S4）。
 *
 * 用法（按规格 §7.3「deploy → 跑校验」时序拆分三种模式）：
 *   DATABASE_URL=... npx tsx scripts/verify-thread-unify.ts --pre    # deploy 前人工跑：
 *       只跑 postPhase1OrphanThreads 前置断言 + I-1/I-2/I-3 碰撞与悬挂预检。
 *   DATABASE_URL=... npx tsx scripts/verify-thread-unify.ts --post   # deploy 后跑：
 *       只跑 orphanMessages=0 / 未归档孤儿线程=0 / 消息总数打印（幂等判据）。
 *   DATABASE_URL=... npx tsx scripts/verify-thread-unify.ts          # 无参数 = 全量
 *       （前置+预检+后置，供本地演练；对已归并库后置绿、对未归并库后置红，
 *        不适合直接做生产 deploy 门禁——见规格 §7.3 时序说明）。
 *
 * 任一断言失败退出码非 0（生产门禁：不通过即停发回滚）。
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const mode = (() => {
  const arg = process.argv[2]
  if (arg === undefined) return 'all'
  if (arg === '--pre' || arg === '--post') return arg.slice(2)
  console.error(`未知参数：${arg}（支持 --pre / --post / 无参数全量）`)
  process.exit(2)
})()

async function main() {
  // 前置断言（规格 §7.2 边界 / §8）：孤儿线程 id 形态与在役 fork（重跑）分支**同构**
  //（生产实证 223 条孤儿全为 `sessionId:后缀` 复合键）。Phase 1 上线（2026-10-26 21:32 CST）
  // 之后出现的孤儿行疑似活跃 fork 分支，归并会破坏重跑特性 ⇒ 必须中止转人工。
  const PHASE1_CUTOFF = 1793021520000 // 2026-10-26 21:32 CST

  let failed = false
  const fail = (message: string) => {
    console.error(message)
    process.exitCode = 1
    failed = true
  }

  // ⚠️ 本仓 Prisma 6.19.3 生成客户端的字段引用（prisma.<model>.fields.<field>）仅被
  // equals/lt 等显式条件对象接受，NOT 包裹 / not / 缩写形式均抛 PrismaClientValidationError
  // （Unknown argument `_ref`）⇒ 三处「threadId/id != sessionId」计数按语义等价改用
  // 参数化 $queryRaw（谓词与迁移 SQL 逐字一致），其余逻辑与 brief 逐字相同。

  if (mode === 'pre' || mode === 'all') {
    const postPhase1OrphanThreads = await prisma
      .$queryRaw<[{ n: bigint }]>`SELECT COUNT(*) AS n FROM "AgentThread" WHERE "id" != "sessionId" AND "createdAt" >= ${new Date(PHASE1_CUTOFF).toISOString()}`
      .then((r) => Number(r[0].n))
    console.log({ postPhase1OrphanThreads })
    if (postPhase1OrphanThreads !== 0) {
      fail(`✗ 发现 ${postPhase1OrphanThreads} 条 Phase 1 上线后创建的孤儿线程——疑似在役 fork（重跑）活跃分支，禁止归并，转人工判定（规格 §7.2 边界）`)
    }

    // ── 应用迁移前的唯一键/引用完整性预检（审查修复轮 1：I-1 / I-2 / I-3；P2 加固：I-1b）──
    // 只读判定，任一致命项非零即禁发迁移（生产 migrate deploy 中断 = 停发回滚）。
    // I-1b 为信息级（步骤1 已放宽去重覆盖，不致命）。
    const [dupRunIdGroups, orphanSharedRunIdCollisions, entryIdCrossConflicts, entryIdInternalDups, missingThreadSessions] = await Promise.all([
      // 预检 I-1（致命）：孤儿侧 (sessionId, runId) 分组计数 >1 的分组数——两条不同孤儿线程的
      // 同键行（共享侧无同键行）会在步3 移动后同落共享线程，撞 @@unique([threadId, runId])
      //（schema.prisma:481）⇒ 生产 migrate deploy 中断。步1 已放宽到「同 (sessionId,runId) 删孤儿」，
      // 但此面（孤儿内部同键重复）步1 不覆盖，必须仍然致命拦截。
      prisma.$queryRaw<[{ n: bigint }]>`SELECT COUNT(*) AS n FROM (SELECT "sessionId", "runId" FROM "AgentMessage" WHERE "threadId" != "sessionId" AND "runId" IS NOT NULL GROUP BY "sessionId", "runId" HAVING COUNT(*) > 1)`.then((r) => Number(r[0].n)),
      // 预检 I-1b（信息，非致命）：孤儿侧 (sessionId, runId) 与共享线程同键的行数——即「审查 P2」
      // 原漏删碰撞面。步1 放宽去重后这些孤儿行会被步1 直接删除，故迁移安全、仅作统计披露，
      // 不致命（否则会阻断本就可安全归并的库）。
      prisma.$queryRaw<[{ n: bigint }]>`SELECT COUNT(*) AS n FROM "AgentMessage" m WHERE m."threadId" != m."sessionId" AND m."runId" IS NOT NULL AND EXISTS (SELECT 1 FROM "AgentMessage" s WHERE s."threadId" = s."sessionId" AND s."sessionId" = m."sessionId" AND s."runId" = m."runId")`.then((r) => Number(r[0].n)),
      // 预检 I-2a：孤儿侧非空 entryId 与非孤儿侧同 entryId 的冲突行数——迁移步2 只按
      // role+content+createdAt 同毫秒去重，createdAt 差毫秒即漏 → 步3 移动撞全局
      // @@unique([entryId])（schema.prisma:483）。
      prisma.$queryRaw<[{ n: bigint }]>`SELECT COUNT(*) AS n FROM "AgentMessage" m WHERE m."threadId" != m."sessionId" AND m."entryId" IS NOT NULL AND EXISTS (SELECT 1 FROM "AgentMessage" s WHERE s."entryId" = m."entryId" AND s."threadId" = s."sessionId")`.then((r) => Number(r[0].n)),
      // 预检 I-2b：孤儿侧内部 entryId 重复行数——移动后互相撞 @@unique([entryId])。
      prisma.$queryRaw<[{ n: bigint }]>`SELECT COUNT(*) AS n FROM "AgentMessage" m WHERE m."threadId" != m."sessionId" AND m."entryId" IS NOT NULL AND EXISTS (SELECT 1 FROM "AgentMessage" d WHERE d."entryId" = m."entryId" AND d."threadId" != d."sessionId" AND d."id" != m."id")`.then((r) => Number(r[0].n)),
      // 预检 I-3：有孤儿消息的每个 sessionId 必须存在 id=sessionId 的 AgentThread 行——
      // 否则步3 SET threadId = sessionId 产出悬挂引用。
      prisma.$queryRaw<[{ n: bigint }]>`SELECT COUNT(*) AS n FROM (SELECT DISTINCT m."sessionId" AS sid FROM "AgentMessage" m WHERE m."threadId" != m."sessionId") o LEFT JOIN "AgentThread" t ON t."id" = o."sid" WHERE t."id" IS NULL`.then((r) => Number(r[0].n)),
    ])

    console.log({ dupRunIdGroups, orphanSharedRunIdCollisions, entryIdCrossConflicts, entryIdInternalDups, missingThreadSessions })

    if (dupRunIdGroups !== 0) {
      fail(`✗ 预检 I-1 失败：孤儿侧 (sessionId, runId) 分组计数>1 的分组共 ${dupRunIdGroups} 组——迁移步3 移动后将撞 @@unique([threadId, runId])，禁止归并，转人工清理`)
    }
    if (orphanSharedRunIdCollisions !== 0) {
      // 信息级：步1 已放宽去重会清掉这些行，归并安全；仅披露以免误判。
      console.warn(`⚠ 预检 I-1b：发现 ${orphanSharedRunIdCollisions} 条孤儿 (sessionId,runId) 与共享线程同键——将由迁移步1 去重，归并安全（非致命）`)
    }
    if (entryIdCrossConflicts !== 0 || entryIdInternalDups !== 0) {
      fail(`✗ 预检 I-2 失败：孤儿侧非空 entryId 冲突 ${entryIdCrossConflicts + entryIdInternalDups} 行（对非孤儿侧 ${entryIdCrossConflicts} + 孤儿内部重复 ${entryIdInternalDups}）——迁移步2 漏去重时步3 移动将撞 @@unique([entryId])，禁止归并，转人工清理`)
    }
    if (missingThreadSessions !== 0) {
      fail(`✗ 预检 I-3 失败：有孤儿消息的 sessionId 中 ${missingThreadSessions} 个不存在 id=sessionId 的 AgentThread 行——迁移步3 移动将产出悬挂引用，禁止归并，转人工补行`)
    }
  }

  if (mode === 'post' || mode === 'all') {
    const [orphanMessages, orphanThreads, totalMessages] = await Promise.all([
      prisma.$queryRaw<[{ n: bigint }]>`SELECT COUNT(*) AS n FROM "AgentMessage" WHERE "threadId" != "sessionId"`.then((r) => Number(r[0].n)),
      prisma.$queryRaw<[{ n: bigint }]>`SELECT COUNT(*) AS n FROM "AgentThread" WHERE "id" != "sessionId" AND "archivedAt" IS NULL`.then((r) => Number(r[0].n)),
      prisma.agentMessage.count(),
    ])

    console.log({ totalMessages, orphanMessages, unarchivedOrphanThreads: orphanThreads })

    if (orphanMessages !== 0) {
      fail(`✗ 仍有 ${orphanMessages} 条孤儿消息（threadId != sessionId）`)
    }
    if (orphanThreads !== 0) {
      fail(`✗ 仍有 ${orphanThreads} 条孤儿线程未归档（id != sessionId 且 archivedAt 为空）`)
    }
    if (!failed) {
      console.log('✓ 归并后置条件全部满足；重跑迁移将影响 0 行（幂等）')
    }
  }
}

main().finally(() => prisma.$disconnect())
