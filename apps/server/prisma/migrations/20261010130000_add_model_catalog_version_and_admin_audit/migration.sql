-- S2-1b 目录运营端点存储落点（spec: docs/superpowers/specs/2026-10-09-mph-s21-catalog-as-data-design.md §3.3/§3.4）：
-- ModelCatalogVersion = 目录版本号（单行，写端点原子 +1，单调递增、last-write-win），
-- ensurePlatformChannel 对齐前比对它实现「保存后台下一次 provider 调用即生效」。
-- AdminAuditLog = admin 写操作审计行（who/when/before/after）。纯 DDL，无回填。

-- CreateTable
CREATE TABLE "ModelCatalogVersion" (
    "id" TEXT NOT NULL DEFAULT 'catalog',
    "version" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "ModelCatalogVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");
