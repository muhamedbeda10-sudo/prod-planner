-- Tie every tank to the daily-log rows it belongs to.
--
-- Until now the two layers were only joined by arithmetic: the ledger said "3
-- painted on this MO" and three tanks said "painted". Delete that log row and
-- the tanks stayed behind, still listed in the barcode tab for a stage nothing
-- records any more. An explicit link lets a deletion carry through in one step,
-- and lets a tank removed from the barcode tab take its own quantity back off
-- the ledger without guessing which row it came from.

ALTER TABLE "TankUnit" ADD COLUMN "weldLedgerId" INTEGER;
ALTER TABLE "TankUnit" ADD COLUMN "paintLedgerId" INTEGER;

-- CreateIndex
CREATE INDEX "TankUnit_weldLedgerId_idx" ON "TankUnit"("weldLedgerId");

-- CreateIndex
CREATE INDEX "TankUnit_paintLedgerId_idx" ON "TankUnit"("paintLedgerId");

-- Backfill for tanks painted before this link existed: the painting action
-- already wrote the serials it covered into the ledger row's note
-- ("tanks: SF-…, SF-…"), so that note is a reliable enough join for the few
-- rows that predate this migration.
UPDATE "TankUnit" t
SET "paintLedgerId" = h."id"
FROM "HandoverEntry" h
WHERE t."paintLedgerId" IS NULL
  AND t."status" = 'painted'
  AND h."dept" = 'Painting'
  AND h."item" = 'TN'
  AND h."note" LIKE 'tanks: %'
  AND position(t."serial" IN h."note") > 0;
