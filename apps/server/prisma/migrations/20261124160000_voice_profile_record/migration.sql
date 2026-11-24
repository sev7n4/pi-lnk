-- VoiceStudio 克隆/设计音色合规台账（spec 2026-11-24-voicestudio-p1p2 §6#3：
-- profile 来源标记）。pi-runtime clone_voice / design_voice 成功后经
-- /agent/internal/voice-profiles upsert 登记；@@unique([userId, profileId]) 幂等。
CREATE TABLE "VoiceProfileRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL,
    "refUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VoiceProfileRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "VoiceProfileRecord_userId_profileId_key" ON "VoiceProfileRecord"("userId", "profileId");
CREATE INDEX "VoiceProfileRecord_userId_createdAt_idx" ON "VoiceProfileRecord"("userId", "createdAt");
CREATE INDEX "VoiceProfileRecord_profileId_idx" ON "VoiceProfileRecord"("profileId");
