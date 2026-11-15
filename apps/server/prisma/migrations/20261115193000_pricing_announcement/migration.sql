-- 调价公告（2026-11-15-pricing-change-announcement-design）：additive，只建表+索引，不改存量行。
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL DEFAULT 'pricing-change',
    "versionFrom" TEXT,
    "versionTo" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "payload" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveAt" DATETIME NOT NULL
);
CREATE INDEX "Announcement_type_publishedAt_idx" ON "Announcement"("type", "publishedAt");

CREATE TABLE "AnnouncementRead" (
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnnouncementRead_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement" ("id") ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "AnnouncementRead_pkey" PRIMARY KEY ("announcementId", "userId")
);
CREATE INDEX "AnnouncementRead_userId_idx" ON "AnnouncementRead"("userId");
