-- 方案丙（2026-10-18）：个人四档纯积分模型落地。
-- 存量会员直接转档，不动积分余额：旧 pro → standard，旧 studio → flagship。
-- 无 grandfather：studio→flagship 原样转移；用户已购积分保留（不回收）。
UPDATE "User" SET "membership" = 'standard' WHERE "membership" = 'pro';
UPDATE "User" SET "membership" = 'flagship' WHERE "membership" = 'studio';
