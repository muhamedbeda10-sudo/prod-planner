ALTER TABLE "MachineDowntime"
  ALTER COLUMN "machineId" DROP NOT NULL,
  ADD COLUMN "customName" TEXT,
  ADD COLUMN "customDept" TEXT,
  ADD COLUMN "customCentre" TEXT,
  ADD COLUMN "startTime" VARCHAR(5),
  ADD COLUMN "endTime" VARCHAR(5),
  ADD COLUMN "endsNextDay" BOOLEAN NOT NULL DEFAULT false;

-- Existing duration-only records retain their hours and never acquire invented clock times.
ALTER TABLE "MachineDowntime" ADD CONSTRAINT "MachineDowntime_equipment_check" CHECK (
  ("machineId" IS NOT NULL AND "customName" IS NULL AND "customDept" IS NULL AND "customCentre" IS NULL)
  OR ("machineId" IS NULL AND length(trim("customName")) > 0 AND "customName" IS NOT NULL
      AND "customDept" IS NOT NULL AND "customDept" IN ('Cut', 'Welding', 'ShotBlast', 'Painting', 'Punching', 'Bending', 'WeldingLV', 'PaintingLV'))
);
ALTER TABLE "MachineDowntime" ADD CONSTRAINT "MachineDowntime_clock_check" CHECK (
  ("startTime" IS NULL AND "endTime" IS NULL AND NOT "endsNextDay")
  OR ("startTime" IS NOT NULL AND "endTime" IS NOT NULL
      AND "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
CREATE INDEX "MachineDowntime_customDept_customName_date_idx" ON "MachineDowntime"("customDept", "customName", "date");
