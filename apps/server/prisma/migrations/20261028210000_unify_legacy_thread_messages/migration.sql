-- apps/server/prisma/migrations/20261028210000_unify_legacy_thread_messages/migration.sql
-- H0-b migrate（规格 §7.2）：把 legacy 孤儿线程消息归并到共享线程（threadId == sessionId）。
-- 幂等来源：三步全是条件 UPDATE/DELETE，重跑影响行数为零。
-- 回滚 = 恢复文件级备份（移动不可逆，规格 §7.2）。
-- ⚠️ 执行前置闸门：verify-thread-unify.ts 的 Phase 1 时刻前置断言必须为 0
--（孤儿线程 id 与在役 fork 分支同构，防误伤活跃分支，规格 §7.2 边界）。

-- 第 1 步：去重——孤儿行与同会话共享线程行同 (sessionId, runId)（runId 非空）时删孤儿侧。
-- runId(=operationId) 标识一次 run，共享线程行即该 run 的权威副本，孤儿侧必为重复，直接去重；
-- 这同时消除「步3 移动撞 @@unique([threadId, runId])」的孤儿/共享碰撞面（审查 P2）：
-- 原逻辑额外要求 role+content 同才会删，导致同 (sessionId,runId) 但 content/role 不同的孤儿行
-- 漏删，步3 移动后撞唯一键 ⇒ 生产 migrate deploy 中断。放宽到同 (sessionId,runId) 即删即可根治。
DELETE FROM "AgentMessage"
WHERE "threadId" != "sessionId"
  AND "runId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "AgentMessage" m2
    WHERE m2."threadId" = m2."sessionId"
      AND m2."sessionId" = "AgentMessage"."sessionId"
      AND m2."runId" = "AgentMessage"."runId"
  );

-- 第 2 步：去重——runId 为空的存量行：同会话 + 同 role + 同 content + 同 createdAt（同毫秒全同文本视为重复）
DELETE FROM "AgentMessage"
WHERE "threadId" != "sessionId"
  AND "runId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "AgentMessage" m2
    WHERE m2."threadId" = m2."sessionId"
      AND m2."sessionId" = "AgentMessage"."sessionId"
      AND m2."role" = "AgentMessage"."role"
      AND m2."content" = "AgentMessage"."content"
      AND m2."createdAt" = "AgentMessage"."createdAt"
  );

-- 第 2.5 步（生产 --pre 闸门 I-3 实证后补入，2026-10-30）：补建缺失的共享线程行。
-- 生产快照实证：187 个会话有孤儿消息但**连 id=sessionId 的 AgentThread 行都不存在**
--（=「193 会话历史不可达」的主体），不补行则步 3 移动产出悬挂 threadId 引用（I-3 拦截）。
-- 自愈语义：title 借 Session.title（画布名，比默认「新对话」信息量大）；
-- createdAt 取该会话最早孤儿消息时间（时序语义自然，Prisma SQLite DateTime=毫秒整数原值）；
-- updatedAt 走 strftime ISO-8601（与步 4 archivedAt 同款先例）。同时间窗（< Phase1 上线时刻）
-- 只补历史债；NOT EXISTS 守卫保证重跑零行（幂等）。
INSERT INTO "AgentThread" ("id", "sessionId", "title", "createdAt", "updatedAt")
SELECT DISTINCT m."sessionId", m."sessionId", COALESCE(NULLIF(s."title", ''), '新对话'),
       (SELECT MIN(m2."createdAt") FROM "AgentMessage" m2
         WHERE m2."sessionId" = m."sessionId" AND m2."threadId" != m2."sessionId"),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM "AgentMessage" m
JOIN "Session" s ON s."id" = m."sessionId"
WHERE m."threadId" != m."sessionId"
  AND m."createdAt" < '2026-10-26T13:32:00Z'
  AND NOT EXISTS (SELECT 1 FROM "AgentThread" t WHERE t."id" = m."sessionId");

-- 第 3 步：移动（createdAt 原值保留，时序天然不变）
-- 纵深防御（审查 P2）：仅动 Phase 1 上线前的历史债（< 2026-10-26T13:32:00Z），
-- 即便跳过 --pre 闸门也绝不碰在役 fork（重跑）分支——这是相比原「全量移动」的关键加固。
-- 配合第 1 步放宽去重，孤儿/共享同 (sessionId,runId) 碰撞面已被步骤 1 消除，此处只移历史行。
-- 再加 EXISTS 守卫（步 2.5 的兜底）：目标共享线程行不存在则不移动，绝不制造悬挂引用。
UPDATE "AgentMessage" SET "threadId" = "sessionId"
WHERE "threadId" != "sessionId"
  AND "createdAt" < '2026-10-26T13:32:00Z'
  AND EXISTS (SELECT 1 FROM "AgentThread" t WHERE t."id" = "AgentMessage"."sessionId");

-- 第 4 步：归档孤儿线程行（保留供审计，含其 turnState）；strftime 产出 Prisma 兼容的 ISO-8601
-- 纵深防御（审查 P2）：同样只归档 Phase 1 上线前的历史孤儿线程，绝不归档在役 fork 分支。
UPDATE "AgentThread"
SET "archivedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE "id" != "sessionId" AND "archivedAt" IS NULL
  AND "createdAt" < '2026-10-26T13:32:00Z';

-- 共享线程的 turnState 不动（规格 §7.2 第 4 条：活跃线程回合连续性状态只认共享线程行）
