-- 授权自动生成（规格 2026-11-22-generation-auto-approve-gate-design §3.2）：
-- 账号级用户偏好 autoApproveGenerations（manual = 未授权/缺省；auto = 已授权）。
-- 用 TEXT + DEFAULT 而非 enum：避免 PG/SQLite enum 迁移风险；判定侧对非法值兜底为 manual。
ALTER TABLE "UserAiPreferences" ADD COLUMN "autoApproveGenerations" TEXT NOT NULL DEFAULT 'manual';
