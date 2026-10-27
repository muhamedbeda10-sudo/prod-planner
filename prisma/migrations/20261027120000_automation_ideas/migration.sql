-- The plant's watchdog is gone: its settings and what it found go with it
-- (nothing else reads them).
DROP TABLE IF EXISTS "WatchFinding";
DROP TABLE IF EXISTS "WatchSettings";

-- The week the assistant last suggested automation ideas for.
ALTER TABLE "AiSettings" ADD COLUMN "ideasWeekISO" TEXT;

-- CreateTable
CREATE TABLE "AutomationIdea" (
    "id" SERIAL NOT NULL,
    "weekISO" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "desc" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "dismissedBy" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationIdea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationIdea_createdAt_idx" ON "AutomationIdea"("createdAt");

-- The assistant's own records: its SQL login has no business with them.
REVOKE ALL ON "AutomationIdea" FROM ai_reader;
