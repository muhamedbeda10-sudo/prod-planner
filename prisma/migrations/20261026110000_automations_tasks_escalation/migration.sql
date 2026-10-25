-- Automations 2.0: an automation may give a task (due in so many days,
-- urgent or not), and a condition's row still matching after a while goes up
-- to the plant's owner. New columns with defaults only — nothing existing changes.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN "taskDueDays" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "taskUrgent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "escalateAfterMin" INTEGER,
ADD COLUMN "keySeenAt" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "escalatedKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
