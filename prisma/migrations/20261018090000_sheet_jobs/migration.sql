-- FABRICATION: the machines work SHEET JOBS. A job typed on the fabrication
-- board is sheets of one thickness, material and size carrying the parts of
-- several projects; it is closed on its machines sheet by sheet. Nest runs
-- and the transformer plan's own lines no longer go on the fabrication
-- machines — the jobs carry that work.

-- AlterTable
ALTER TABLE "ManualJob" ADD COLUMN "bySheet" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ManualJobPart" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER NOT NULL,
    "bom" TEXT NOT NULL DEFAULT '',
    "item" TEXT NOT NULL DEFAULT '',
    "part" TEXT NOT NULL,
    "pcs" INTEGER NOT NULL,

    CONSTRAINT "ManualJobPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualJobPart_jobId_idx" ON "ManualJobPart"("jobId");

-- CreateIndex
CREATE INDEX "ManualJobPart_bom_idx" ON "ManualJobPart"("bom");

-- AddForeignKey
ALTER TABLE "ManualJobPart" ADD CONSTRAINT "ManualJobPart_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ManualJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A clean start on the fabrication machines (agreed with the plant): every
-- transformer queue row comes off them — the plan's lines, the nest runs and
-- the jobs typed in pieces. The panels' rows on the shared punches (item
-- "PNL") stay. Recorded output, the sheet cut log and the nest runs
-- themselves are not touched.
DELETE FROM "WorklistMachine" WHERE "dept" = 'Cut' AND "item" <> 'PNL';

-- The fabrication jobs still open were typed in pieces: they are closed, and
-- stay in the Manual jobs list as finished. New jobs are typed in sheets.
UPDATE "ManualJob" SET "doneAt" = CURRENT_TIMESTAMP WHERE "dept" = 'Cut' AND "doneAt" IS NULL;
