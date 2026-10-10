-- S1-1 探活 run 补触发来源列（B3 批次，writeRunRecord 落 reason）：
-- 'startup'|'periodic'|'manual'。纯 DDL 加列，可空、旧行为 NULL、无回填。
-- AlterTable
ALTER TABLE "UpstreamProbeRun" ADD COLUMN "reason" TEXT;
