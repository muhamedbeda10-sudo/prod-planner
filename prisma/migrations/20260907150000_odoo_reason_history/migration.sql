-- The Reason column of the ODOO log keeps its history: every value it has
-- held on a row, oldest first. The office rewrites the reason as Odoo answers
-- and wants the earlier answers kept.

-- CreateTable
CREATE TABLE "OdooReasonHistory" (
    "id" SERIAL NOT NULL,
    "entryId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedBy" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdooReasonHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OdooReasonHistory_entryId_idx" ON "OdooReasonHistory"("entryId");

-- AddForeignKey
ALTER TABLE "OdooReasonHistory" ADD CONSTRAINT "OdooReasonHistory_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "OdooEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: the reason each existing row holds today is its first history entry.
INSERT INTO "OdooReasonHistory" ("entryId", "reason", "recordedBy", "at")
SELECT "id", "reason", "recordedBy", "updatedAt"
FROM "OdooEntry"
WHERE "reason" IS NOT NULL AND btrim("reason") <> '';
