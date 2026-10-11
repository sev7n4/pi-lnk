-- model-ops Task 1 默认模型数据化：ModelCatalogEntry 补 isDefault 列。
-- 1) 加列（可空语义用 DEFAULT false 兜底）；
-- 2) 部分唯一索引：每模态至多一个活默认（软删行不占坑，SQLite 支持 partial index）；
-- 3) 回填：按 shared DEFAULT_MODEL_KEYS 现值（text=agnes-2.5-flash /
--    image=agnes-image-2.1-flash / video=agnes-video-2.5-flash /
--    audio=minimax-speech-2.8-hd）UPDATE 活行；已被下架的默认键 UPDATE 0 行无害。
-- ⚠️ 与 shared studioModelCatalog.ts DEFAULT_MODEL_KEYS 保持同步（仓内注释互锚）。
-- AlterTable
ALTER TABLE "ModelCatalogEntry" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;
-- CreateIndex
CREATE UNIQUE INDEX "ModelCatalogEntry_live_default_per_modality" ON "ModelCatalogEntry"("modality") WHERE "isDefault" = 1 AND "deletedAt" IS NULL;
-- Backfill
UPDATE "ModelCatalogEntry" SET "isDefault" = 1
WHERE "deletedAt" IS NULL AND "modelKey" IN (
  'agnes-2.5-flash', 'agnes-image-2.1-flash', 'agnes-video-2.5-flash', 'minimax-speech-2.8-hd'
);
