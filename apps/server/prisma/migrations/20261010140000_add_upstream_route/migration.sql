-- S2-2 上游路由表配置化（spec: docs/superpowers/specs/2026-10-09-mph-s22-routing-table-design.md §3.1）：
-- 「哪个模型走哪个上游」从 resolver if/else 链迁为数据驱动路由表。纯 DDL，无回填；
-- 种子从 legacy resolver 链逐条翻译（shared UPSTREAM_ROUTE_SEEDS），应用侧播种
-- （insert-if-absent 只插不改，存在即跳过）。enabled=false 即下线该行，无软删列。
-- fallbackApiKeyEnvName 记录 apimart 的 openai key 回落语义
-- （legacy resolveApimartPlatformCredentials：apimartApiKey || openaiApiKey）。

-- CreateTable
CREATE TABLE "UpstreamRoute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchType" TEXT NOT NULL,
    "pattern" TEXT,
    "capability" TEXT NOT NULL,
    "upstream" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fallbackApiKeyEnvName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "UpstreamRoute_enabled_priority_idx" ON "UpstreamRoute"("enabled", "priority");
