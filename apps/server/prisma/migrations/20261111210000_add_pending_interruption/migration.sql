-- P2 durable 待确认门：纯 additive 新表（不改任何存量表/列）。
-- 落库走 `prisma migrate deploy`（本仓库禁用 auto-merge）；回滚 = revert 本 commit。
-- 与 AgentEvent 账本同策略：不做存量回填（老会话无源 callId/timeoutMs，读路径直通）。

CREATE TABLE "PendingInterruption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "runId" TEXT,
    "callId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ask_user',
    "questionsJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answerJson" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "PendingInterruption_threadId_callId_key"
    ON "PendingInterruption"("threadId", "callId");
CREATE INDEX "PendingInterruption_threadId_status_idx"
    ON "PendingInterruption"("threadId", "status");
CREATE INDEX "PendingInterruption_status_expiresAt_idx"
    ON "PendingInterruption"("status", "expiresAt");
