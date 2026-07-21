-- Track EVERY monthly plan an order appeared in (CSV of month labels), so a
-- carried-over MO shows under each of its months in the tracker filter.
ALTER TABLE "MasterOrder" ADD COLUMN "months" TEXT NOT NULL DEFAULT '';
UPDATE "MasterOrder" SET "months" = COALESCE("source", '');
