-- AgentMessage 补「已接住」权威终态两列（2026-11-11，插话气泡实时化 + 消费终态）。
--
-- 【要修的 bug】`AgentMessage.queued` 在 DB 里恒为 true、从不写 false（生产 66/66 实证）；
--   「翻 false」只是 getMessages 读时派生（「同窗内有更晚 assistant 行」≈「被消费」）。
--   生产取证（66 条 queued=1 插话行）：52 条完整链路、13 条**永久滞留 pi inbox、
--   从未进 transcript（模型从未看到）**——其中 12 条所在 thread 后来有过别的回答，
--   读时派生照样把它们判成「已发送」，用户看不出丢消息。
--
-- 【修法（规格 docs/superpowers/specs/2026-11-11-queue-user-bubble-context-verify-design.md）】
--   - consumedAt：服务端观察到 `pi_message_end{role=user, entryId}` 命中 queued=true 行
--     时写入（entry 已物化进 transcript ⇒ 必被下一轮 readBoundedContext 读入）。
--     「事件已发 ⇔ 已进上下文被接住」。
--   - reconciled：对账脚本判定 entry 既不在 transcript 也不在 inbox 且超时 ⇒ true
--     （滞留终态，UI 显「未接住」，绝不因「有后续回答」而误显已发送）。
--   - 读时派生降级为 consumedAt==NULL 时的 legacy fallback（存量行无权威信号，
--     删派生会让历史插话回显「排队中」——回归）。
--
-- 【为什么纯 additive】SQLite 加可空列/带默认值列不重写表；存量行 consumedAt=NULL、
--   reconciled=false，读路径对 NULL/false 的行为与迁移前完全一致 ⇒ 可原样回滚。

ALTER TABLE "AgentMessage" ADD COLUMN "consumedAt" DATETIME;
ALTER TABLE "AgentMessage" ADD COLUMN "reconciled" BOOLEAN NOT NULL DEFAULT false;
