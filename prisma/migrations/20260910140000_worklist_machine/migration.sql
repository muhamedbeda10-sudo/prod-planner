-- Which machine a worklist line is on and its place in the machine's queue.

CREATE TABLE "WorklistMachine" (
    "id" SERIAL NOT NULL,
    "dept" TEXT NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "machineId" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "setBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorklistMachine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorklistMachine_dept_bom_mo_item_key" ON "WorklistMachine"("dept", "bom", "mo", "item");
CREATE INDEX "WorklistMachine_machineId_idx" ON "WorklistMachine"("machineId");
ALTER TABLE "WorklistMachine" ADD CONSTRAINT "WorklistMachine_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
