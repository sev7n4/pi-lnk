-- CreateTable
CREATE TABLE "conversation_shares" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "htmlSnapshot" TEXT NOT NULL,
    "staticPath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME
);

-- CreateIndex
CREATE INDEX "conversation_shares_sessionId_idx" ON "conversation_shares"("sessionId");

-- CreateIndex
CREATE INDEX "conversation_shares_expiresAt_idx" ON "conversation_shares"("expiresAt");
