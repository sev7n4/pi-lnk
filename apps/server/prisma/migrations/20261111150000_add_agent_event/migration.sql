-- SSE 事件一等化 P1a PR-B（spec docs/superpowers/plans/2026-11-11-sse-event-firstclass-p1a.md §2.1）
-- AgentEvent append-only 事件账本：纯 additive 新表，零存量改写、可原样回滚。
-- 落库走 `prisma migrate deploy`（本仓库禁用 auto-merge）。

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "gSeq" INTEGER NOT NULL,
    "sSeq" INTEGER NOT NULL,
    "runId" TEXT,
    "type" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AgentThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable 对应索引：游标查询 (threadId, gSeq) 升序 + 唯一键 (threadId, gSeq, sSeq) 幂等
CREATE UNIQUE INDEX "AgentEvent_threadId_gSeq_sSeq_key" ON "AgentEvent"("threadId", "gSeq", "sSeq");
CREATE INDEX "AgentEvent_threadId_gSeq_idx" ON "AgentEvent"("threadId", "gSeq");
