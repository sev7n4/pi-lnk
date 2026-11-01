-- apps/server/prisma/migrations/20261101090000_add_idempotency_normalized_intent/migration.sql
-- P4 意图级去重（根治规格 2026-11-01-red-car-disconnect-misreport-duplicate-rootfix §8.3 / §9-P4）：
-- 在既有 IdempotencyRecord 上新增归一化意图列 + (threadId, normalizedIntent) 索引，
-- 供 streamConversation 入口按「同 thread + 同归一化意图 + 近窗」去重，
-- 根除断线误报诱导重发导致的双图（②）。与 HTTP 层随机幂等键解耦，不改其 @unique。
-- 落库需走 `prisma migrate deploy`；本 PR 禁用 auto-merge（历史 P3009 停机教训）。

-- AlterTable
ALTER TABLE "IdempotencyRecord" ADD COLUMN "normalizedIntent" TEXT;

-- CreateIndex
CREATE INDEX "IdempotencyRecord_threadId_normalizedIntent_idx" ON "IdempotencyRecord"("threadId", "normalizedIntent");
