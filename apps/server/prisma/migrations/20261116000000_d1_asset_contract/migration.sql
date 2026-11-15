-- D-1 资产契约（spec §7）：既有 model 加列，全部可空，零数据迁移；禁新增 model（路标 §5.3）。
ALTER TABLE "Shot" ADD COLUMN "axisSide" TEXT;
ALTER TABLE "Shot" ADD COLUMN "screenDirection" TEXT;
ALTER TABLE "Shot" ADD COLUMN "shotSize" TEXT;
ALTER TABLE "Shot" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "Shot" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "Shot" ADD COLUMN "version" INTEGER;
ALTER TABLE "Shot" ADD COLUMN "pinnedAssetId" TEXT;
ALTER TABLE "Story" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "Story" ADD COLUMN "lockedAt" DATETIME;
ALTER TABLE "Story" ADD COLUMN "lockedVersion" INTEGER;
