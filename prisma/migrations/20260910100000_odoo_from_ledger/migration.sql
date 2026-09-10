-- A painting closing (and the core's shot blast) writes its own row on the
-- ODOO tab, so the office only has to type Odoo's MO number. The row keeps
-- the ledger entry it came from; while nobody has touched it, it follows that
-- entry's edits and deletion.

ALTER TABLE "OdooEntry" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "OdooEntry" ADD COLUMN "ledgerId" INTEGER;
ALTER TABLE "OdooEntry" ADD COLUMN "fgGuessed" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "OdooEntry_ledgerId_key" ON "OdooEntry"("ledgerId");
