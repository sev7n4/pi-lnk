-- S2-1 模型目录数据化（spec: docs/superpowers/specs/2026-10-09-mph-s21-catalog-as-data-design.md）：
-- DB 是模型目录的唯一真源；STUDIO_MODEL_CATALOG 代码常量降级为播种种子
-- （insert-if-absent，按 modelKey 存在即跳过，绝不覆盖）。纯 DDL，无回填；
-- 下架 = 软删（deletedAt，同 S0-1 语义），软删行不因播种复活。

-- CreateTable
CREATE TABLE "ModelCatalogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "gatewayModelId" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "providerBinding" TEXT NOT NULL,
    "audioKind" TEXT,
    "voices" TEXT,
    "params" TEXT NOT NULL,
    "defaults" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelCatalogEntry_modelKey_key" ON "ModelCatalogEntry"("modelKey");

-- CreateIndex
CREATE INDEX "ModelCatalogEntry_modality_deletedAt_idx" ON "ModelCatalogEntry"("modality", "deletedAt");
