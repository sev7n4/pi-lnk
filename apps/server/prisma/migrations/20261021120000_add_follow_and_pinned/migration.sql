-- 创作者经济闭环的最小数据基础（2026-10-21 P2）：
--   1. Follow 表——「A 关注 B」的一条边，让创作者页有关注/取关与粉丝数。
--   2. User.pinnedWorkIds——创作者置顶精选的作品 id 列表（JSON 字符串）。
--
-- ⚠️ pinnedWorkIds 用 JSON 字符串而非标量列表：SQLite 连接器不支持 `String[]`
--    （Prisma 报 P1012）。读写约定：写 `JSON.stringify(ids)`，读出后 `JSON.parse`
--    并在服务层校验形状，解析失败回落空数组。
--
-- 手写迁移而非 `prisma migrate dev`：仓库既有迁移历史与当前 schema 不同步
-- （影子库校验会在 AgentMessage 上失败），手写与既有风格保持一致
-- （IF NOT EXISTS + 中文意图注释）。

CREATE TABLE IF NOT EXISTS "Follow" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "followerId" TEXT NOT NULL,
  "followingId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 复合唯一：数据库层挡住「重复关注」，服务端捕获冲突转幂等成功（用户连点两次不该报错）
CREATE UNIQUE INDEX IF NOT EXISTS "Follow_followerId_followingId_key" ON "Follow"("followerId", "followingId");
-- 反向查询索引：创作者页要查「谁关注了我」
CREATE INDEX IF NOT EXISTS "Follow_followingId_idx" ON "Follow"("followingId");
CREATE INDEX IF NOT EXISTS "Follow_followerId_idx" ON "Follow"("followerId");

-- 置顶作品 id 列表（JSON 数组字符串）。默认值 '[]' = 未置顶任何作品。
ALTER TABLE "User" ADD COLUMN "pinnedWorkIds" TEXT NOT NULL DEFAULT '[]';
