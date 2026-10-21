-- AgentMessage 补 user 消息身份键 entryId（2026-10-21，steer 落库 + 统一 user 消息身份）。
--
-- 【要修的 bug】插话（steering）/ 尾随（followUp）走队列 API
--   （`POST /api/agent/runs/steer|followup` → pi-runtime `POST /sessions/:id/steer|followup`），
--   Nest 侧**只把 text 转发给 pi-runtime、拿到 { queued } 就返回，从不建 AgentMessage 行**
--   （对比正常 prompt 路径 `agent.service.ts:413` 有 `agentMessage.create`）。
--   而刷新后历史读的是 `getMessages`（`agent.service.ts:233`，**只查本表**）
--   ⇒ **用户插过的话，刷新后历史里凭空消失**（只在刷新前的实时气泡里可见）。
--
-- 【为什么不是「客户端消费时补写」】那会把落库押在「客户端在线且等到消费」上：
--   关页面 / 切走 / 断网 ⇒ 消息已被 pi 收下甚至已回答，历史里却没有 ⇒ 丢的正是最该留的。
--
-- 【关键前提：entryId 在「入队那一刻」就可得】因此**服务端即可原子落库**、零竞态：
--   vendor `QueueResult` 自带 `{entryId}`，`services/pi-runtime/src/session-manager.ts:2517`
--   （steer）与 `:2583`（followUp）已经是
--     `return { queued: true, entryId: res.value.entryId }`
--   —— #507（撤回插话）已把它接出来，本迁移直接复用，**不改 pi-runtime 一行**。
--   ⇒ 幂等键天然存在，无需再引入 `clientMsgId` 之类的第二把键。
--
-- 【为什么唯一约束，而不是「先 find 再 create」】
--   「先 find 再 create」在并发/重试下必然漏（两个写者都查到「不存在」→ 都插）。
--   唯一索引把「同一条发言至多一行」从**各端默契**升级为**数据库不变式**
--   —— 与既有 `@@unique([threadId, runId])` 对 assistant 的作用完全同构。
--
-- 【可空 + 唯一：存量零回填】assistant 行与**全部存量 user 行**该键都是 NULL，
--   而 SQLite 下 NULL 互不冲突（唯一索引不视为重复）
--   ⇒ 迁移纯 additive、可原样回滚、不动任何既有数据。
--
-- 【为什么不是 NOT NULL】SQLite 加 NOT NULL 列需**重建表**
--   （CREATE / INSERT SELECT / DROP / RENAME）⇒ 外键、索引都要逐一复刻，风险高。
--   且 assistant 行本来就不该有 entryId ⇒ 应用层保证「user 行才有」即足够。

ALTER TABLE "AgentMessage" ADD COLUMN "entryId" TEXT;

-- 同一条发言至多一行：消息重放、多次重试、客户端与服务端双写都命中即 no-op。
-- ⚠️ 这个索引是本迁移的**核心不变式**，不要为了「省一点写开销」去掉：
--   去掉后并发双写会插出重复气泡（生产已出现过同 run 4 条助手消息的同类事故）。
CREATE UNIQUE INDEX IF NOT EXISTS "AgentMessage_entryId_key" ON "AgentMessage"("entryId");