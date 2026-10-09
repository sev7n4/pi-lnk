-- S1-1 定时探活对账（spec: docs/superpowers/specs/2026-10-09-mph-s11-liveness-reconciliation-design.md）：
-- 每次对某上游 /v1/models 的实测落一帧，ghosts/missing 为 JSON 数组字符串，error 非空
-- 表示本次探测失败。只增不改，无需回填；供 S1-2 端点与运维 SQL 检查。
-- CreateTable
CREATE TABLE "UpstreamProbeRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ranAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "upstream" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "modelCount" INTEGER,
    "ghosts" TEXT,
    "missing" TEXT,
    "error" TEXT
);

-- CreateIndex
CREATE INDEX "UpstreamProbeRun_upstream_ranAt_idx" ON "UpstreamProbeRun"("upstream", "ranAt");
