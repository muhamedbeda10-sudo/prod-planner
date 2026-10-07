-- Nest runs: sheets of one thickness on a cutting machine, carrying parts of several jobs.
CREATE TABLE "NestRun" (
    "id" SERIAL NOT NULL,
    "dept" TEXT NOT NULL DEFAULT 'Cut',
    "material" TEXT NOT NULL,
    "thicknessMm" DOUBLE PRECISION NOT NULL,
    "sheetSize" TEXT NOT NULL DEFAULT '',
    "sheets" INTEGER NOT NULL,
    "sheetsDone" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NestRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NestRun_dept_idx" ON "NestRun"("dept");

CREATE TABLE "NestRunPart" (
    "id" SERIAL NOT NULL,
    "runId" INTEGER NOT NULL,
    "bom" TEXT NOT NULL,
    "mo" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "pcs" INTEGER NOT NULL,
    "donePcs" INTEGER NOT NULL DEFAULT 0,
    "consumedPcs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NestRunPart_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NestRunPart_runId_idx" ON "NestRunPart"("runId");
CREATE INDEX "NestRunPart_bom_mo_item_idx" ON "NestRunPart"("bom", "mo", "item");

ALTER TABLE "NestRunPart" ADD CONSTRAINT "NestRunPart_runId_fkey" FOREIGN KEY ("runId") REFERENCES "NestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
