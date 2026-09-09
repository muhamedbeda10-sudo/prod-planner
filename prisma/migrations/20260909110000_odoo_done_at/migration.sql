-- When a row was closed: set the moment its Status is moved to Done, cleared
-- when it is moved away again. The dashboard counts closings by this day, not
-- by the day the row was logged. Rows already Done are taken as closed on the
-- day they were logged — the only day known for them.

ALTER TABLE "OdooEntry" ADD COLUMN "doneAt" TIMESTAMP(3);
CREATE INDEX "OdooEntry_doneAt_idx" ON "OdooEntry"("doneAt");

UPDATE "OdooEntry" SET "doneAt" = "date"
WHERE "doneAt" IS NULL AND lower(trim("status")) IN ('done', 'closed');
