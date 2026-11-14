-- S1 additive migration: PricingSubject table + additive columns on pricing models.
-- Production source of truth (deploy/docker/docker-entrypoint.sh runs `prisma migrate deploy`).
-- IMPORTANT: no existing PriceListEntry / CostRate / MarginPolicy / PriceListVersion row is
-- modified beyond the targeted backfill at the bottom (which never touches PriceListEntry rows).

-- 1) PricingSubject (new table)
CREATE TABLE "PricingSubject" (
  "id" TEXT NOT NULL,
  "subjectKey" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "modelKey" TEXT NOT NULL,
  "spec" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "upstream" TEXT NOT NULL,
  "channelId" TEXT NOT NULL DEFAULT 'platform',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "billableUnit" TEXT NOT NULL,
  "unitsPerRequest" REAL,
  "defaultSubjectKey" TEXT,
  "source" TEXT NOT NULL DEFAULT 'auto',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PricingSubject_subjectKey_key" ON "PricingSubject"("subjectKey");

-- 2) PriceListVersion.additive
ALTER TABLE "PriceListVersion" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- 3) PriceListEntry.additive
ALTER TABLE "PriceListEntry" ADD COLUMN "subjectKey" TEXT;
ALTER TABLE "PriceListEntry" ADD COLUMN "costSnapshotYuan" REAL;
ALTER TABLE "PriceListEntry" ADD COLUMN "unitSnapshot" TEXT;
ALTER TABLE "PriceListEntry" ADD COLUMN "profitBpSnapshot" INTEGER;
ALTER TABLE "PriceListEntry" ADD COLUMN "marginPolicyId" TEXT;
ALTER TABLE "PriceListEntry" ADD COLUMN "reason" TEXT;

-- 4) CostRate.additive
ALTER TABLE "CostRate" ADD COLUMN "provider" TEXT;
ALTER TABLE "CostRate" ADD COLUMN "upstream" TEXT;
ALTER TABLE "CostRate" ADD COLUMN "unitQuantity" REAL NOT NULL DEFAULT 1;
ALTER TABLE "CostRate" ADD COLUMN "effectiveFrom" DATETIME;
ALTER TABLE "CostRate" ADD COLUMN "effectiveTo" DATETIME;
ALTER TABLE "CostRate" ADD COLUMN "sourceRef" TEXT;
ALTER TABLE "CostRate" ADD COLUMN "provisional" BOOLEAN NOT NULL DEFAULT 0;

-- 5) MarginPolicy.additive
ALTER TABLE "MarginPolicy" ADD COLUMN "scope" TEXT;
ALTER TABLE "MarginPolicy" ADD COLUMN "scopeKey" TEXT;
ALTER TABLE "MarginPolicy" ADD COLUMN "profitBp" INTEGER;
ALTER TABLE "MarginPolicy" ADD COLUMN "priceFloorBp" INTEGER;
ALTER TABLE "MarginPolicy" ADD COLUMN "effectiveFrom" DATETIME;
ALTER TABLE "MarginPolicy" ADD COLUMN "effectiveTo" DATETIME;
ALTER TABLE "MarginPolicy" ADD COLUMN "status" TEXT;

-- 6) Backfill existing rows (no PriceListEntry rows touched)
UPDATE "CostRate" SET "unitQuantity" = CASE "unit" WHEN 'per_1m_tokens' THEN 1000000 ELSE 1 END;
UPDATE "CostRate" SET "unitQuantity" = 100 WHERE "spec" = 'per_100_chars';
UPDATE "CostRate" SET "provisional" = 1 WHERE "note" LIKE '%PROVISIONAL%' OR "note" LIKE '%线性推算%' OR "spec" = 'per_song' OR "spec" = 'per_100_chars';
UPDATE "MarginPolicy" SET "scope" = 'global', "profitBp" = 1000, "priceFloorBp" = 500, "status" = 'active' WHERE "phase" = 'launch';
UPDATE "PriceListVersion" SET "revision" = 0;

-- 7) Partial unique index: at most one subjectKey per (versionId, subjectKey); NULLs allowed
CREATE UNIQUE INDEX IF NOT EXISTS "PriceListEntry_versionId_subjectKey_key"
  ON "PriceListEntry"("versionId", "subjectKey") WHERE "subjectKey" IS NOT NULL;
