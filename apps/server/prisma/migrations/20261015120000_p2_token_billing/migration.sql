-- AlterTable
ALTER TABLE "User" ADD COLUMN "pointsFrozen" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PointHold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "settledCredits" INTEGER,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" DATETIME,
    CONSTRAINT "PointHold_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PointHold_userId_status_idx" ON "PointHold"("userId", "status");

-- CreateIndex
CREATE INDEX "PointHold_status_createdAt_idx" ON "PointHold"("status", "createdAt");
