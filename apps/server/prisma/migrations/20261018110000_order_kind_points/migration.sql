-- 积分充值（风险 #2 扩展）：Order 增加 kind/points。
-- kind: 'subscription'（存量默认）| 'topup'（积分充值）；
-- points: topup 订单发放总积分（基础+赠送），subscription 为 NULL。附加式，不动存量行语义。
ALTER TABLE "Order" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'subscription';
ALTER TABLE "Order" ADD COLUMN "points" INTEGER;
