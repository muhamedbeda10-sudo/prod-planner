-- Output recorded AFTER a tracker push now consumes the pushed quantity.
-- baseDone snapshots the dept total at push time; existing pushes are
-- backfilled with the current totals so nothing shrinks retroactively.
ALTER TABLE "WorklistPush" ADD COLUMN "baseDone" DOUBLE PRECISION NOT NULL DEFAULT 0;
UPDATE "WorklistPush" p
SET "baseDone" = COALESCE(
  (SELECT SUM(h."qty") FROM "HandoverEntry" h WHERE h."mo" = p."mo" AND h."item" = p."item" AND h."dept" = p."dept"),
  0
);
