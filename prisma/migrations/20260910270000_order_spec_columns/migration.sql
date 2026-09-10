-- Four more of the plan's own columns on the tracker, beside KVA: the sheet's
-- Fins and CRC Size (imported with the monthly plan, like Color RAL), and SFM,
-- which no plan sheet carries — the planner types it on the tracker.
ALTER TABLE "MasterOrder" ADD COLUMN "fins" TEXT;
ALTER TABLE "MasterOrder" ADD COLUMN "crcSize" TEXT;
ALTER TABLE "MasterOrder" ADD COLUMN "sfm" TEXT;
