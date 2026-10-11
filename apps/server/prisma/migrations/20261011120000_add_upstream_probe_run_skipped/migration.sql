-- model-ops Task 3 探活盲区声明：UpstreamProbeRun 补 skipped 列。
-- 'probeMode=none' = 该上游无 /models 在售清单，本轮有意跳过拉取与 diff（非失败）。
-- 纯 DDL 加列，可空、旧行为 NULL、无回填（复刻 reason 列模式）。
-- AlterTable
ALTER TABLE "UpstreamProbeRun" ADD COLUMN "skipped" TEXT;
