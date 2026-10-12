-- Automations: what a person asked the assistant to do by itself, and each
-- time one fired; the scheduler's secret and heartbeat on the settings row;
-- the inbox items and the changes an automation made point back at it.

-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "tickSecretHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lastTickAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AiInboxItem" ADD COLUMN     "fromUserId" INTEGER;

-- CreateTable
CREATE TABLE "Automation" (
    "id" SERIAL NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT NOT NULL,
    "times" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "days" TEXT NOT NULL DEFAULT 'working',
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "conditionSql" TEXT,
    "checkEveryMin" INTEGER NOT NULL DEFAULT 30,
    "activeFrom" TEXT,
    "activeTo" TEXT,
    "action" TEXT NOT NULL,
    "message" TEXT,
    "prompt" TEXT,
    "recipientIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "lastKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastCheckAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastNote" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" SERIAL NOT NULL,
    "automationId" INTEGER NOT NULL,
    "cause" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" TEXT,
    "error" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inboxIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "actionIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Automation_enabled_nextRunAt_idx" ON "Automation"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "Automation_ownerId_idx" ON "Automation"("ownerId");

-- CreateIndex
CREATE INDEX "AutomationRun_automationId_startedAt_idx" ON "AutomationRun"("automationId", "startedAt");

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An automation id an AiAction or an inbox item carries from before points
-- nowhere (none were made before this) — cleared, so the keys can be added.
UPDATE "AiAction" SET "automationId" = NULL WHERE "automationId" IS NOT NULL;
UPDATE "AiInboxItem" SET "automationId" = NULL WHERE "automationId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "AiAction" ADD CONSTRAINT "AiAction_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInboxItem" ADD CONSTRAINT "AiInboxItem_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInboxItem" ADD CONSTRAINT "AiInboxItem_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The assistant's own records: its queries, its instructions, whom it tells.
REVOKE ALL ON "Automation" FROM ai_reader;
REVOKE ALL ON "AutomationRun" FROM ai_reader;
