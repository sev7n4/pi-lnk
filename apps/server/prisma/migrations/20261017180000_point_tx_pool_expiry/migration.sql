-- 多池记账（spec docs/superpowers/specs/2026-10-13-billing-points-system-design §多池）：
-- PointTransaction 增加 pool / expiresAt / orderId，支撑积分账目按池审计、有效期与订单溯源。
-- 纯 additive：存量行 pool 默认 'granted'，expiresAt / orderId 为 NULL，不丢失任何既有数据。
-- 结算路径仍以 User.points 为单一权威余额，本迁移不改动计费扣减链路。
ALTER TABLE "PointTransaction" ADD COLUMN "pool" TEXT NOT NULL DEFAULT 'granted';
ALTER TABLE "PointTransaction" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "PointTransaction" ADD COLUMN "orderId" TEXT;
CREATE INDEX "PointTransaction_userId_pool_idx" ON "PointTransaction"("userId", "pool");
