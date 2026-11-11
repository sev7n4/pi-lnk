-- P1c 清债（账本投影）：AgentEvent 补 messageIndex（回合内 assistant 消息段归属）与 (threadId, runId) 索引。
-- 纯 additive：新列带默认值 0（存量行=「无分段信息」，语义为第 0 段，消费端可接受）。
ALTER TABLE "AgentEvent" ADD COLUMN "messageIndex" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "AgentEvent_threadId_runId_idx" ON "AgentEvent"("threadId", "runId");
