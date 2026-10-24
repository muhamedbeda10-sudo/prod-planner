-- Where each worker was within his department (Fabrication's laser, bending
-- and fin folding), why a machine stood still, and the planner's own hours a
-- piece per work centre. Additions only: every existing row keeps its value.
ALTER TABLE "ShiftEntry" ADD COLUMN "center" TEXT;

ALTER TABLE "MachineDowntime" ADD COLUMN "reasonCode" TEXT;

CREATE TABLE "CenterStdTime" (
    "id" SERIAL NOT NULL,
    "kva" INTEGER NOT NULL,
    "item" TEXT NOT NULL,
    "center" TEXT NOT NULL,
    "hoursPerPc" DOUBLE PRECISION NOT NULL,
    "setBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CenterStdTime_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CenterStdTime_kva_item_center_key" ON "CenterStdTime"("kva", "item", "center");
