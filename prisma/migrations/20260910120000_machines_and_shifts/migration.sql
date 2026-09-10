-- Machines and the shift log. The plant's machines by department (the
-- fabrication list from the planner's sheet; the paint lines and shot-blast
-- cabinets under placeholder codes the admin renames), the supervisor's
-- daily record of who worked, how long and on what, and machine downtime.

CREATE TABLE "Machine" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dept" TEXT NOT NULL,
    "center" TEXT NOT NULL DEFAULT '',
    "hoursPerDay" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Machine_code_key" ON "Machine"("code");
CREATE INDEX "Machine_dept_idx" ON "Machine"("dept");

CREATE TABLE "ShiftEntry" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dept" TEXT NOT NULL,
    "workerId" INTEGER NOT NULL,
    "present" BOOLEAN NOT NULL DEFAULT true,
    "shift" TEXT NOT NULL DEFAULT 'S9',
    "overtimeH" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "machineId" INTEGER,
    "note" TEXT,
    "recordedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShiftEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShiftEntry_date_dept_workerId_key" ON "ShiftEntry"("date", "dept", "workerId");
CREATE INDEX "ShiftEntry_date_dept_idx" ON "ShiftEntry"("date", "dept");
ALTER TABLE "ShiftEntry" ADD CONSTRAINT "ShiftEntry_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShiftEntry" ADD CONSTRAINT "ShiftEntry_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MachineDowntime" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "machineId" INTEGER NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MachineDowntime_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MachineDowntime_date_idx" ON "MachineDowntime"("date");
CREATE INDEX "MachineDowntime_machineId_idx" ON "MachineDowntime"("machineId");
ALTER TABLE "MachineDowntime" ADD CONSTRAINT "MachineDowntime_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The plant's machines. ON CONFLICT DO NOTHING: re-running never overwrites
-- what the admin has since renamed.
INSERT INTO "Machine" ("code", "name", "dept", "center", "sortOrder", "createdAt", "updatedAt") VALUES
  ('B4-10', 'Bodor 3K watt',     'Cut', 'Cutting',   1,  NOW(), NOW()),
  ('B4-09', 'Bodor 6K watt',     'Cut', 'Cutting',   2,  NOW(), NOW()),
  ('B4-07', 'Yawy 1K watt',      'Cut', 'Cutting',   3,  NOW(), NOW()),
  ('B4-06', 'Yawy Punching',     'Cut', 'Cutting',   4,  NOW(), NOW()),
  ('B4-05', 'Yawy Punching',     'Cut', 'Cutting',   5,  NOW(), NOW()),
  ('B4-04', 'Yawy Punching',     'Cut', 'Cutting',   6,  NOW(), NOW()),
  ('B4-03', 'Yawy Punching',     'Cut', 'Cutting',   7,  NOW(), NOW()),
  ('B4-18', 'Laser Tubes',       'Cut', 'Tubes',     8,  NOW(), NOW()),
  ('B5-02', 'Fins',              'Cut', 'Fins',      9,  NOW(), NOW()),
  ('B4-16', 'Laser Roll Blank',  'Cut', 'RollBlank', 10, NOW(), NOW()),
  ('B4-12', 'GF 6k watt',        'Cut', 'Cutting',   11, NOW(), NOW()),
  ('B4-11', 'GF 6k watt',        'Cut', 'Cutting',   12, NOW(), NOW()),
  ('SB-1',  'Shot blast 1',      'ShotBlast', 'Line', 1, NOW(), NOW()),
  ('SB-2',  'Shot blast 2',      'ShotBlast', 'Line', 2, NOW(), NOW()),
  ('PL-1',  'Paint line 1',      'Painting',  'Line', 1, NOW(), NOW()),
  ('PL-2',  'Paint line 2',      'Painting',  'Line', 2, NOW(), NOW())
ON CONFLICT ("code") DO NOTHING;
