-- GenerationRecord.updatedAt 补列（2026-10-21，修既存生产 bug）。
--
-- 【bug 现象】`late-generation-notify.ts` 的 reaper 扫描按 `updatedAt` 查
--   `GenerationRecord`（where: `updatedAt.gte` + orderBy: `updatedAt.asc`），
--   但本表**从来没有 updatedAt 列**（只有 createdAt）⇒ prisma 运行时参数校验错误，
--   每约 5 分钟在生产刷一次屏。⇒ **「回合外终态通报」功能从 #459 合入（2026-10-18）
--   起就一直是坏的**。
--
-- 【为什么必须补列，不能改用 createdAt】
--   本表是**可变**的：studio.service.ts 有 40+ 处 update（status 流转 completed/failed/
--   fallback_pending、url 回填、metadata 写入）⇒ `createdAt` ≠ 最后变更时刻。
--   而 reaper 的语义是「最近 10 分钟内**进入终态**的记录」，其注释原话：
--   *"终态后 10min 内必被扫到"*（回看窗 10min > reaper 5min 巡检间隔）。
--   ⛔ 用 createdAt 的后果：一个 3 小时前创建、1 分钟前完成的生成记录落在
--   10min 回看窗**之外** ⇒ 永远扫不到 ⇒ 用户收不到「生成完成」通知
--   ⇒ 破坏 reaper 的核心保证。
--
-- 【为什么分两步：加可空列 + 回填】
--   SQLite 的 `ALTER TABLE ADD COLUMN` **拒绝非恒定默认值**
--   （实测：`Cannot add a column with non-constant default`）⇒
--   `DEFAULT CURRENT_TIMESTAMP` 用不了 ⇒ 只能先加可空列再回填。
--
-- 【回填口径：createdAt 作下界】
--   老行的「最后变更时刻」已不可知 ⇒ 用 createdAt 近似。
--   语义安全性：createdAt ≤ 最后变更时刻 ⇒ 回填值是**真实值的下界** ⇒
--   只会「早扫」（把老记录纳入窗口）而不会「漏扫」（把新终态排除在外）。
--   早扫是安全的：通报有 durable 去重键 `metadata.agentTurnNotified`（durable，进程重启不重发）。
--
-- 【NOT NULL 约束：未加，刻意的】
--   SQLite 加 NOT NULL 列需**重建表**（CREATE/INSERT SELECT/DROP/RENAME）⇒ 风险高
--   （外键、索引、触发器都要逐一复刻）而收益边际很小：
--   - prisma 的 `@updatedAt` 在 create/update 时**由客户端自动写入**（已实测）；
--   - 老行已由本迁移回填；
--   ⇒ 应用层保证非空。DB 层无硬约束是本次的**已知取舍**。
--   （仓库用手写迁移、不跑 `prisma migrate dev`，无 shadow DB drift 检测；
--     且仓库既有迁移历史与当前 schema 本就不同步，不是本次引入。）

ALTER TABLE "GenerationRecord" ADD COLUMN "updatedAt" DATETIME;

-- 回填：老行用 createdAt 作下界（见上文口径说明）
UPDATE "GenerationRecord" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

-- reaper 的扫描索引：按「最后变更」取最近窗口的终态记录。
-- ⚠️ 与既有的 [userId, sessionId, createdAt] **不是**替代关系 ——
--    后者服务用户维度的历史列表，前者服务状态流转的时间窗扫描。
CREATE INDEX IF NOT EXISTS "GenerationRecord_updatedAt_idx" ON "GenerationRecord"("updatedAt");
