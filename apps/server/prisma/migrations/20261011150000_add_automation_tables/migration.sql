-- C5 Automations P0：调度配置表 + 运行史表
CREATE TABLE "AutomationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "handlerKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleType" TEXT NOT NULL DEFAULT 'interval',
    "intervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "params" TEXT,
    "concurrencyPolicy" TEXT NOT NULL DEFAULT 'forbid',
    "runOnStartup" BOOLEAN NOT NULL DEFAULT false,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "failureWebhook" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "output" TEXT,
    "error" TEXT,
    CONSTRAINT "AutomationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AutomationJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AutomationRun_jobId_startedAt_idx" ON "AutomationRun"("jobId", "startedAt");
