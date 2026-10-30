-- apps/server/prisma/migrations/20261028200000_add_thread_archived_at/migration.sql
-- H0-b expand：纯 additive 加列，可原样回滚（规格 §7.1 / K2）
ALTER TABLE "AgentThread" ADD COLUMN "archivedAt" DATETIME;
