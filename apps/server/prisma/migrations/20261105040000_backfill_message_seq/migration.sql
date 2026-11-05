-- 投影面 seq 收口（2026-11-05，多端一致性 P4-T2 / 迁移 20261022043000 五步走的**步 4**）。
--
-- 【要收口的不变式】`AgentMessage.seq` = 会话内单调序号（D6）。
--   步 1（20261022043000）只加列未回填：全表 NULL、零写方、无任何读路径依赖。
--   本迁移完成：存量回填（可重放口径）→ NULL 闸门 → `@@unique([threadId, seq])`。
--   写方（P4-T1，先行合入）：全部 4 个 `agentMessage.create/upsert` 写点统一走
--   `runWithMessageSeq`（agent-message-seq.ts，max+1 + P2002 重试）。
--
-- 【回填口径与 computeSeqs 互证】排序键 = (threadId, createdAt, id)，每 thread 从 1 连续
--   （session-projection.service.ts `computeSeqs` 的全序定义）。SQL 侧用 ROW_NUMBER
--   窗口函数，与 TS 实现逐行同序——口径双实现，fixture 验证记录见计划文档 §T2。
--   ⛔ 实测教训（fixture 互证抓到）：不要写「MAX(seq) 偏移 + 仅编号 NULL 行」的
--   防御形态——UPDATE 自引用同表时，后处理的行会读到前面行**刚写入**的 seq，
--   MAX 被自己污染（t1 实测 2/3/6，正确为 1/2/3）。单遍全量重编号天然免疫，
--   且语义恰等于 computeSeqs 对全表重算（幂等可重放），索引在迁移末尾才建，
--   中途重编号不撞唯一索引。
--
-- 【为什么 NOT NULL 闸门是硬要求】SQLite 唯一索引下 NULL 互不冲突——
--   若回填有漏，唯一索引对 NULL 行形同虚设（本仓 runId 可空付过代价：
--   9443 条 assistant 里 9368 条（99.2%）唯一索引失效，spec §3 / D6 判据）。
--   SQLite 的 RAISE(ABORT) 只能在触发器体内使用，这里用等价物：
--   向 NOT NULL 临时表插 NULL ⇒ NOT NULL constraint failed ⇒ 迁移中止。
--
-- 【回滚】纯 additive（UPDATE 既有列值 + 新索引）。回滚镜像不认识 seq 列也无妨
--   （旧代码不写 seq ⇒ 新行 NULL，唯一索引下 NULL 互不冲突，行为等价迁移前）。

UPDATE "AgentMessage"
SET "seq" = (
  SELECT rn FROM (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "threadId"
             ORDER BY "createdAt", "id"
           ) AS rn
    FROM "AgentMessage"
  ) t
  WHERE t."id" = "AgentMessage"."id"
);

-- 闸门：仍有 NULL ⇒ 整个迁移失败（不许带病上索引）。
CREATE TABLE "_p4_seq_null_gate" ("n" INTEGER NOT NULL);
INSERT INTO "_p4_seq_null_gate" ("n")
  SELECT "seq" FROM "AgentMessage" WHERE "seq" IS NULL LIMIT 1;
DROP TABLE "_p4_seq_null_gate";

-- 会话内全序落成数据库不变式：同 thread 内 seq 至多一行。
CREATE UNIQUE INDEX IF NOT EXISTS "AgentMessage_threadId_seq_key" ON "AgentMessage"("threadId", "seq");
