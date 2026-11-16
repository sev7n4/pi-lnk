-- Skills 控制面三表（规格 v1 §7.1 / ADR-0016）
CREATE TABLE "SkillPackage" (
    "contentHash" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL DEFAULT '1',
    "publisher" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "version" TEXT NOT NULL,
    "frontmatter" TEXT NOT NULL DEFAULT '{}',
    "body" TEXT NOT NULL,
    "license" TEXT,
    "source" TEXT NOT NULL,
    "marketplaceSource" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "disableModelInvocation" BOOLEAN NOT NULL DEFAULT false,
    "userInvocable" BOOLEAN NOT NULL DEFAULT true,
    "allowedCapabilities" TEXT NOT NULL DEFAULT '[]',
    "compatProfile" TEXT NOT NULL DEFAULT 'C0',
    "compatScore" REAL NOT NULL DEFAULT 0,
    "scanReport" TEXT NOT NULL DEFAULT '{}',
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SkillPackage_publisher_skill_contentHash_key" ON "SkillPackage"("publisher", "skill", "contentHash");

CREATE TABLE "SkillCatalog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageHash" TEXT NOT NULL,
    "vertical" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "owner" TEXT NOT NULL DEFAULT '',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "installCount" INTEGER NOT NULL DEFAULT 0,
    "rankScore" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SkillCatalog_packageHash_key" ON "SkillCatalog"("packageHash");
CREATE INDEX "SkillCatalog_vertical_reviewStatus_idx" ON "SkillCatalog"("vertical", "reviewStatus");

CREATE TABLE "UserInstalledSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "packageHash" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "trustLevel" TEXT NOT NULL DEFAULT 'unreviewed',
    "scope" TEXT NOT NULL DEFAULT 'user',
    "pinnedHash" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "override" TEXT NOT NULL DEFAULT '{}',
    "userModified" BOOLEAN NOT NULL DEFAULT false,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME,
    "lastLoadedSessionId" TEXT
);
CREATE UNIQUE INDEX "UserInstalledSkill_userId_packageHash_key" ON "UserInstalledSkill"("userId", "packageHash");
CREATE INDEX "UserInstalledSkill_userId_uninstalledAt_idx" ON "UserInstalledSkill"("userId", "uninstalledAt");
CREATE INDEX "UserInstalledSkill_packageHash_idx" ON "UserInstalledSkill"("packageHash");
