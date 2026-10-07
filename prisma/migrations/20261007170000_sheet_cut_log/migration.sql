-- Which sheet of which item each machine cut, and when.
CREATE TABLE "SheetCutLog" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date" TIMESTAMP(3) NOT NULL,
    "dept" TEXT NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "sheet" TEXT NOT NULL,
    "thicknessMm" DOUBLE PRECISION,
    "machineId" INTEGER,
    "qty" INTEGER NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "SheetCutLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SheetCutLog_machineId_idx" ON "SheetCutLog"("machineId");
CREATE INDEX "SheetCutLog_item_idx" ON "SheetCutLog"("item");
CREATE INDEX "SheetCutLog_date_idx" ON "SheetCutLog"("date");

ALTER TABLE "SheetCutLog" ADD CONSTRAINT "SheetCutLog_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
