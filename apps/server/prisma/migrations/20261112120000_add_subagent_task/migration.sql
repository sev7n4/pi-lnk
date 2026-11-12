-- D2 子代理一等任务单据：纯 additive 新表（不改任何存量表/列）。
-- 落库走 `prisma migrate deploy`（本仓库禁用 auto-merge）；回滚 = revert 本 commit。
-- 与 AgentEvent 账本 / P2 PendingInterruption 同策略：不做存量回填
-- （历史 82 条 truncated 无源 callId，读路径直通）。

CREATE TABLE "SubagentTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "runId" TEXT,
    "parentSessionKey" TEXT,
    "taskPreview" TEXT,
    "status" TEXT NOT NULL DEFAULT 'spawned',
    "outcomeJson" TEXT,
    "reason" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "SubagentTask_threadId_callId_key"
    ON "SubagentTask"("threadId", "callId");
CREATE UNIQUE INDEX "SubagentTask_requestId_key"
    ON "SubagentTask"("requestId");
CREATE INDEX "SubagentTask_threadId_status_idx"
    ON "SubagentTask"("threadId", "status");
CREATE INDEX "SubagentTask_status_expiresAt_idx"
    ON "SubagentTask"("status", "expiresAt");
