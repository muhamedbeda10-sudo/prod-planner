-- The planner's own time per piece, per item, per machine. Where a figure is
-- set it outranks the standard-times estimate: the machine's queue is priced
-- with it and the ⚡ planner schedules with it. Nothing is seeded — every
-- machine starts on the estimate until somebody types a real number.
CREATE TABLE "MachineItemTime" (
    "id" SERIAL NOT NULL,
    "machineId" INTEGER NOT NULL,
    "item" TEXT NOT NULL,
    "hoursPerPc" DOUBLE PRECISION NOT NULL,
    "setBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MachineItemTime_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MachineItemTime_machineId_item_key" ON "MachineItemTime"("machineId", "item");
CREATE INDEX "MachineItemTime_machineId_idx" ON "MachineItemTime"("machineId");
ALTER TABLE "MachineItemTime" ADD CONSTRAINT "MachineItemTime_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
