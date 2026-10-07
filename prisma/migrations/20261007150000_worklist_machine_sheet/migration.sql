-- One item on several machines at once, each cutting one sheet of it.
ALTER TABLE "WorklistMachine" ADD COLUMN "sheet" TEXT NOT NULL DEFAULT '';
ALTER TABLE "WorklistMachine" ADD COLUMN "sheetDone" INTEGER NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS "WorklistMachine_dept_bom_mo_item_machineId_key";
CREATE UNIQUE INDEX "WorklistMachine_dept_bom_mo_item_machineId_sheet_key" ON "WorklistMachine"("dept", "bom", "mo", "item", "machineId", "sheet");
