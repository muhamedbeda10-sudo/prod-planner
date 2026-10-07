-- Jobs put on a machine from outside the plan, kept to come back to.
CREATE TABLE "ManualJob" (
    "id" SERIAL NOT NULL,
    "dept" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bom" TEXT NOT NULL DEFAULT '',
    "item" TEXT NOT NULL DEFAULT '',
    "qty" INTEGER NOT NULL,
    "doneQty" INTEGER NOT NULL DEFAULT 0,
    "material" TEXT NOT NULL DEFAULT '',
    "thicknessMm" DOUBLE PRECISION,
    "sheetSize" TEXT NOT NULL DEFAULT '',
    "sheets" DOUBLE PRECISION,
    "note" TEXT,
    "machineId" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ManualJob_dept_idx" ON "ManualJob"("dept");
CREATE INDEX "ManualJob_machineId_idx" ON "ManualJob"("machineId");

ALTER TABLE "ManualJob" ADD CONSTRAINT "ManualJob_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
