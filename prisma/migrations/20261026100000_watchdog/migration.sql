-- The watchdog: its settings (one row) and what it found each day. New
-- tables only — nothing existing changes.

-- CreateTable
CREATE TABLE "WatchSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "at" TEXT NOT NULL DEFAULT '07:15',
    "dropPct" INTEGER NOT NULL DEFAULT 30,
    "absencePct" INTEGER NOT NULL DEFAULT 15,
    "chronicDays" INTEGER NOT NULL DEFAULT 3,
    "chronicOf" INTEGER NOT NULL DEFAULT 5,
    "lateMinDays" INTEGER NOT NULL DEFAULT 1,
    "recipientIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "aiSummary" BOOLEAN NOT NULL DEFAULT true,
    "lastRunISO" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastFindings" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchFinding" (
    "id" SERIAL NOT NULL,
    "dayISO" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "mo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WatchFinding_dayISO_key_key" ON "WatchFinding"("dayISO", "key");
CREATE INDEX "WatchFinding_createdAt_idx" ON "WatchFinding"("createdAt");
