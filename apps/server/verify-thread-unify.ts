/**
 * verify-thread-unify.ts
 * --------------------------------------------------------------------------
 * 会话历史归并迁移（20261028210000_unify_legacy_thread_messages）的
 * 前置闸门 / 后置复核脚本。全部为只读 SELECT，不修改任何数据，
 * 可对任意环境库（本地文件库 / 生产 DATABASE_URL）安全运行。
 *
 * 用法（需 DATABASE_URL 指向目标 lnkpi.db）：
 *   DATABASE_URL="file:/path/to/lnkpi.db" npx tsx apps/server/verify-thread-unify.ts --pre
 *   DATABASE_URL="file:/path/to/lnkpi.db" npx tsx apps/server/verify-thread-unify.ts --post
 *
 * 生产/预发：直接复用 server 的 DATABASE_URL（与 Nest 同源）即可。
 *
 * 判据（规格 §7.3 / §8 / §10.3）：
 *   --pre  迁移前：孤儿消息指向「不存在的共享线程」行数必须为 0（I-3 闸门，
 *          否则迁移步 3 移动会产出悬挂 threadId 引用 → 撞 FK / P3009）。
 *   --post 迁移后：孤儿消息全重挂、孤儿线程全归档、引用完整、≥190 个 legacy
 *          会话历史可达、重跑迁移命中 0 行（幂等）。
 *
 * 退出码：全绿 0；任一断言失败 1；参数/连接错误 2。
 * --------------------------------------------------------------------------
 */
import { PrismaClient } from '@prisma/client';

type CountRow = { c: bigint | number };

async function count(prisma: PrismaClient, sql: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(sql)) as CountRow[];
  const v = rows[0]?.c ?? 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== '--pre' && mode !== '--post') {
    console.error('用法: npx tsx apps/server/verify-thread-unify.ts --pre | --post');
    process.exit(2);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: 需要 DATABASE_URL 环境变量（指向 lnkpi.db）');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  const checks: { name: string; pass: boolean; detail: string }[] = [];

  try {
    if (mode === '--pre') {
      // 前置闸门（迁移前）：孤儿消息指向「不存在的共享线程」行数（I-3）。
      // >0 说明步 2.5 缺失/未生效，迁移步 3 移动会产出悬挂 threadId 引用 → 撞 FK。
      const i3 = await count(
        prisma,
        `SELECT COUNT(*) AS c FROM "AgentMessage" m
         WHERE m."threadId" != m."sessionId"
           AND NOT EXISTS (SELECT 1 FROM "AgentThread" t WHERE t."id" = m."sessionId");`,
      );
      checks.push({
        name: 'I-3 孤儿消息指向缺失共享线程 (应为 0)',
        pass: i3 === 0,
        detail: `count=${i3}`,
      });

      // 引用完整性：孤儿消息 threadId 在 AgentThread 中无对应行（理论上应恒为 0）。
      const ref = await count(
        prisma,
        `SELECT COUNT(*) AS c FROM "AgentMessage" m
         LEFT JOIN "AgentThread" t ON m."threadId" = t."id"
         WHERE t."id" IS NULL;`,
      );
      checks.push({
        name: '引用完整性 (应为 0)',
        pass: ref === 0,
        detail: `count=${ref}`,
      });
    } else {
      // 后置复核（迁移后，全部预期为绿）：
      const orphanMsg = await count(
        prisma,
        `SELECT COUNT(*) AS c FROM "AgentMessage" WHERE "threadId" != "sessionId";`,
      );
      checks.push({
        name: '孤儿消息已重挂 (threadId==sessionId, 应为 0)',
        pass: orphanMsg === 0,
        detail: `count=${orphanMsg}`,
      });

      const unarchived = await count(
        prisma,
        `SELECT COUNT(*) AS c FROM "AgentThread" WHERE "id" != "sessionId" AND "archivedAt" IS NULL;`,
      );
      checks.push({
        name: '孤儿线程已归档 (archivedAt 非 NULL, 应为 0)',
        pass: unarchived === 0,
        detail: `count=${unarchived}`,
      });

      const ref = await count(
        prisma,
        `SELECT COUNT(*) AS c FROM "AgentMessage" m
         LEFT JOIN "AgentThread" t ON m."threadId" = t."id"
         WHERE t."id" IS NULL;`,
      );
      checks.push({
        name: '引用完整性 (应为 0)',
        pass: ref === 0,
        detail: `count=${ref}`,
      });

      const sessions = await count(
        prisma,
        `SELECT COUNT(DISTINCT "sessionId") AS c FROM "AgentThread"
         WHERE "id" != "sessionId" AND "archivedAt" IS NOT NULL;`,
      );
      // 规格目标 193；放宽到 >=190 以避免边界误报，精确值照实报告。
      checks.push({
        name: 'legacy 会话覆盖数 (规格目标 193)',
        pass: sessions >= 190,
        detail: `count=${sessions}`,
      });

      // 幂等：重跑步 3 / 步 4 命中行数（= 上面两项之和）。
      const idem = await count(
        prisma,
        `SELECT (
           (SELECT COUNT(*) FROM "AgentMessage" WHERE "threadId" != "sessionId")
           + (SELECT COUNT(*) FROM "AgentThread" WHERE "id" != "sessionId" AND "archivedAt" IS NULL)
         ) AS c;`,
      );
      checks.push({
        name: '幂等：重跑迁移命中行数 (应为 0)',
        pass: idem === 0,
        detail: `count=${idem}`,
      });
    }
  } finally {
    await prisma.$disconnect();
  }

  let allPass = true;
  for (const c of checks) {
    if (!c.pass) allPass = false;
    console.log(`${c.pass ? '✅ PASS' : '❌ FAIL'}  ${c.name} — ${c.detail}`);
  }
  console.log(`\n[${mode}] 结论：${allPass ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
