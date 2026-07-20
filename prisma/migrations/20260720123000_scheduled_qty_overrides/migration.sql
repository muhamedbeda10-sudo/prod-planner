-- Date-less lines can now be scheduled in PARTS: several dates per line, each
-- with a quantity from the open pool. baseDone snapshots the dept output at
-- scheduling time (consumption baseline for FIFO-earliest allocation).
ALTER TABLE "WorklistDateOverride" ADD COLUMN "qty" DOUBLE PRECISION;
ALTER TABLE "WorklistDateOverride" ADD COLUMN "baseDone" DOUBLE PRECISION NOT NULL DEFAULT 0;

DROP INDEX "WorklistDateOverride_bom_mo_item_origISO_key";
CREATE UNIQUE INDEX "WorklistDateOverride_bom_mo_item_origISO_newDate_key" ON "WorklistDateOverride"("bom", "mo", "item", "origISO", "newDate");
