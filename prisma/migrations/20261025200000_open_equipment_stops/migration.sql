ALTER TABLE "MachineDowntime"
  ADD COLUMN "isOpen" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "endDate" DATE;
-- Preserve all existing recorded durations and clock ranges. No end is invented or removed.
ALTER TABLE "MachineDowntime" DROP CONSTRAINT "MachineDowntime_clock_check";
ALTER TABLE "MachineDowntime" ADD CONSTRAINT "MachineDowntime_clock_check" CHECK (
  ("isOpen" AND "hours" = 0 AND "startTime" IS NOT NULL
    AND "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "endTime" IS NULL AND "endDate" IS NULL AND NOT "endsNextDay")
  OR (NOT "isOpen" AND (
    ("startTime" IS NULL AND "endTime" IS NULL AND "endDate" IS NULL AND NOT "endsNextDay")
    OR ("startTime" IS NOT NULL AND "endTime" IS NOT NULL
      AND "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND ("endDate" IS NULL OR "endDate" >= "date"::date))
  ))
);
CREATE INDEX "MachineDowntime_isOpen_date_idx" ON "MachineDowntime"("isOpen", "date");
