-- 用户显式停用的平台模型清单（JSON 数组，存编码后的 `platform::<modelKey>`）。
-- 目的：区分「用户主动停用某模型」与「该模型是新上架的」—— 两者在 selectable 快照里
-- 同为「少一条」，此前无法区分（audio-model-backfill.ts 头注释），导致 bootstrap 只能
-- 冻结快照、上新模型必须人工回填（StepFun 42 用户回填即后果）。
-- 有了显式停用记录，bootstrap 自动对齐即可安全并入新模型而不复活用户停用的模型。
-- 停用记录由 PUT /provider/preferences 的 prev/next diff 在后端推导，前端零改动。
ALTER TABLE "UserAiPreferences" ADD COLUMN "disabledModels" TEXT NOT NULL DEFAULT '[]';
