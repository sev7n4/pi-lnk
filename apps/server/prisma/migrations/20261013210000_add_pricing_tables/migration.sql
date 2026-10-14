-- P0 定价等价迁移：价目表三表 + 流水 ruleVersion（spec §4）
CREATE TABLE "PriceListVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" DATETIME
);
CREATE UNIQUE INDEX "PriceListVersion_version_key" ON "PriceListVersion"("version");

CREATE TABLE "PriceListEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'legacy-equivalent',
    "costRateId" TEXT,
    CONSTRAINT "PriceListEntry_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PriceListVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PriceListEntry_costRateId_fkey" FOREIGN KEY ("costRateId") REFERENCES "CostRate"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PriceListEntry_versionId_matchKey_key" ON "PriceListEntry"("versionId", "matchKey");
CREATE INDEX "PriceListEntry_versionId_capability_idx" ON "PriceListEntry"("versionId", "capability");

CREATE TABLE "CostRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "costYuan" REAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'official_list',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CostRate_channel_modelKey_spec_key" ON "CostRate"("channel", "modelKey", "spec");

CREATE TABLE "MarginPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phase" TEXT NOT NULL,
    "anchorCents" INTEGER NOT NULL DEFAULT 1,
    "marginBp" INTEGER NOT NULL DEFAULT 11000,
    "capabilityOverrides" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MarginPolicy_phase_key" ON "MarginPolicy"("phase");

ALTER TABLE "PointTransaction" ADD COLUMN "ruleVersion" TEXT;
