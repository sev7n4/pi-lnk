-- AlterTable
ALTER TABLE "PointTransaction" ADD COLUMN "grayReleaseId" TEXT;

-- CreateTable
CREATE TABLE "PricingGrayRelease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'admin',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PricingGrayRelease_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PriceListVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PricingGrayWhitelist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "releaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "note" TEXT,
    CONSTRAINT "PricingGrayWhitelist_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "PricingGrayRelease" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PricingGrayRelease_status_endsAt_idx" ON "PricingGrayRelease"("status", "endsAt");

-- CreateIndex
CREATE INDEX "PricingGrayWhitelist_userId_idx" ON "PricingGrayWhitelist"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingGrayWhitelist_releaseId_userId_key" ON "PricingGrayWhitelist"("releaseId", "userId");
