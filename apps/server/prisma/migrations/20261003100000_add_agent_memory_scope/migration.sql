-- 记忆作用域隔离（2026-10-03 生产事故：同画布会话读到另一画布的项目记忆）
-- 加 scope / sessionId / source 三列 + 复合索引 @@index([userId, scope, sessionId])。
-- ⚠️ 语句形状 = `prisma migrate dev` 对「旧 schema → 新 schema」的原生产出（SQLite 走 RedefineTables：
--    建新表 → 搬数据 → DROP 原表 → 改名 → 建索引）。手写增量 ALTER 会让后续 migrate 产生噪音 diff。
-- scope 默认 'user'：上线后旧记忆行为不变，可秒级回滚；收紧交给 scripts/backfill-memory-scope.ts。
-- 旧索引 agent_memories_userId_idx 随 DROP TABLE 一并消失，被新索引左前缀完全覆盖。
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- RedefineTables
CREATE TABLE "new_agent_memories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'user',
    "sessionId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'agent_auto',
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_agent_memories" ("content", "createdAt", "id", "userId") SELECT "content", "createdAt", "id", "userId" FROM "agent_memories";
DROP TABLE "agent_memories";
ALTER TABLE "new_agent_memories" RENAME TO "agent_memories";
CREATE INDEX "agent_memories_userId_scope_sessionId_idx" ON "agent_memories"("userId", "scope", "sessionId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
