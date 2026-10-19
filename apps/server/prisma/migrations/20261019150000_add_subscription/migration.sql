-- 订阅实体：把「连续包月」从文案层落到数据层。
-- User.membership 只是档位快查字段；周期/到期/取消续期标记以本表为准。
-- 一个用户只保留一条「当前订阅」；历史订单仍在 Order 表。
CREATE TABLE IF NOT EXISTS "Subscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "plan" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "periodStart" DATETIME NOT NULL,
  "periodEnd" DATETIME NOT NULL,
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT 0,
  "agreementNo" TEXT,
  "canceledAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Subscription_userId_status_idx" ON "Subscription"("userId", "status");
CREATE INDEX IF NOT EXISTS "Subscription_periodEnd_idx" ON "Subscription"("periodEnd");

-- 存量付费用户（pro→standard / studio→flagship 已在上一个迁移完成）没有周期数据：
-- 保守起见不给存量行补周期（periodEnd 无从推断），到期失效只对新建订阅生效。
-- 这批用户下一次支付同档即自动补建订阅并顺延。
