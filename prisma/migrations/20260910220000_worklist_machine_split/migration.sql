-- A line can be split over machines: each row now says how many pieces sit
-- on its machine (null = the rest), and the same line may have a row per
-- machine.
ALTER TABLE "WorklistMachine" ADD COLUMN "qty" INTEGER;
DROP INDEX IF EXISTS "WorklistMachine_dept_bom_mo_item_key";
CREATE UNIQUE INDEX "WorklistMachine_dept_bom_mo_item_machineId_key" ON "WorklistMachine"("dept", "bom", "mo", "item", "machineId");
CREATE INDEX "WorklistMachine_dept_bom_mo_item_idx" ON "WorklistMachine"("dept", "bom", "mo", "item");
