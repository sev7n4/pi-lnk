-- 回合身份与单一写者（2026-10-17）：给 AgentMessage 加「一次 run 一条账」的不变式。
--
-- 纯 additive：可空列 + 唯一索引。SQLite 下 NULL 互不冲突，
-- 故存量 400+ 行**零回填**、迁移失败可原样回滚（DROP INDEX + SQLite 3.35+ DROP COLUMN）。

-- AlterTable
ALTER TABLE "AgentMessage" ADD COLUMN "runId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AgentMessage_threadId_runId_key" ON "AgentMessage"("threadId", "runId");
