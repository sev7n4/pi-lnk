-- apps/server/prisma/migrations/20261103000000_add_point_transaction_session_id/migration.sql
-- Epic 1（spec 2026-11-03-credit-consumption-display-design）：PointTransaction 关联会话。
-- 可空列，兼容存量行、后台赠送与订阅续期；索引按迁移纪律延后至观察期后单独立迁移。
-- 落库走 `prisma migrate deploy`（本仓库禁用 auto-merge）。

-- AlterTable
ALTER TABLE "PointTransaction" ADD COLUMN "sessionId" TEXT;
