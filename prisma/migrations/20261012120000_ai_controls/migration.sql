-- The owner's finer controls over the assistant: how hard it thinks (effort),
-- a model and effort of its own for the automations and the morning review,
-- caps per day beside the monthly ones, how many steps one question may
-- take, and when automations may run at all (hours and weekdays on the
-- factory clock) and when the morning review goes out.

-- AlterTable
ALTER TABLE "AiSettings"
    ADD COLUMN "effort" TEXT NOT NULL DEFAULT 'medium',
    ADD COLUMN "autoModel" TEXT NOT NULL DEFAULT 'claude-opus-5-5',
    ADD COLUMN "autoEffort" TEXT NOT NULL DEFAULT 'medium',
    ADD COLUMN "dailyUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "maxCalls" INTEGER NOT NULL DEFAULT 14,
    ADD COLUMN "autoFrom" TEXT,
    ADD COLUMN "autoTo" TEXT,
    ADD COLUMN "autoWeekdays" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::INTEGER[],
    ADD COLUMN "reviewAt" TEXT NOT NULL DEFAULT '07:30',
    ADD COLUMN "reviewPaused" BOOLEAN NOT NULL DEFAULT false;

-- the automations keep running on the model they ran on until now
UPDATE "AiSettings" SET "autoModel" = "model";

-- AlterTable
ALTER TABLE "AiAccess" ADD COLUMN "dailyUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
