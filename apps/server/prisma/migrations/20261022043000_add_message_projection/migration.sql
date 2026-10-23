-- 投影面三列（2026-10-22，多端同会话一致性 · Task 7 / D6）。
--
-- 【要修的 bug】刷新后的历史是「按 createdAt 排序后整体替换」，没有任何
--   会话内单调序号 ⇒ 客户端无法回答「我拿到的是不是全部」：
--   - 分页/续传只能靠 createdAt 做游标，同毫秒写入的消息会在页边界重复或漏掉；
--   - 历史与实时增量各记一本账，到达顺序一变就错位（M1 复发的根因）。
--   `seq` 把「会话内的全序」落成数据库里的**可查、可比、可续传**的事实。
--
-- 【为什么分五步走，本文件只做第 1 步】
--   步 1 加列（本文件，纯 additive）→ 步 2 部署观察 → 步 3 回填排序单测
--   → 步 4 回填 + 唯一索引 → 步 5 snapshot 端点。
--   ⛔ 回填与唯一索引**不进本迁移**：回填要动存量每一行，必须先有一次
--   「加列后一切照旧」的生产观察窗口，否则出问题时无法分辨是新列还是回填写的。
--
-- 【为什么三列都可空 / 有默认，不加任何索引】
--   SQLite 加 NOT NULL 列需重建表（CREATE / INSERT SELECT / DROP / RENAME），
--   外键与索引要逐一复刻，风险高；`queued` 用恒定默认值即可避免，
--   `seq`/`clientId` 则本就允许为 NULL（见下）。
--   本步之后**行为与今天完全一致**：没有任何读路径引用这三列。
--
-- 【`seq` 为什么可空，以及为什么这是刻意的临时态】
--   存量行（生产 9k+ 条）在加列瞬间全是 NULL。计划是步 4 回填后加
--   `@@unique([threadId, seq])`——届时**必须**先断言无 NULL：
--   SQLite 唯一索引下 NULL 互不冲突（本仓已因 `runId` 可空付过代价，
--   9443 条 assistant 里 9368 条（99.2%）唯一索引形同虚设），
--   所以步 4 的 `RAISE(ABORT)` 闸门是硬要求，不是可选项。
--
-- 【`clientId` 为什么现在不加唯一索引】乐观插入的幂等键（spec §5.5）要求
--   「同一 clientId 至多一行」，但该不变式只有在 Task 9 把 clientId 一路贯通
--   到落库路径后才成立；现在加索引会挡住「尚未贯通」的正常写入。
--   与 `seq` 一起在步 4 收口（同样先断言无 NULL）。

ALTER TABLE "AgentMessage" ADD COLUMN "seq" INTEGER;
ALTER TABLE "AgentMessage" ADD COLUMN "clientId" TEXT;
ALTER TABLE "AgentMessage" ADD COLUMN "queued" BOOLEAN NOT NULL DEFAULT false;
