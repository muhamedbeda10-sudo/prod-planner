-- The material tab takes the shape of the planner's Nesting Tracker sheet,
-- filed month by month:
--   month          the plan month the sheet was imported for (part of the key,
--                  so re-importing a month updates its lines rather than
--                  doubling them)
--   units          the sheet's "Quantity of Units", now typed/imported rather
--                  than derived — backfilled from the old override, else from
--                  the orders registry exactly as the tab used to derive it
--   producedQty    new: units actually produced so far, against which the
--                  sheets really consumed are worked out
--   sheetsPerUnit  the sheet's per-unit figure, mandatory again
--   sheetsUsed     the sheet's actual nesting, blank until nested — nullable again
-- unitsOverride is folded into units. workedAt is dropped: the month tag now
-- carries the "when" the planner asked for, at the grain they asked for it.

ALTER TABLE "MaterialUsage" ADD COLUMN "month" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MaterialUsage" ADD COLUMN "units" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "MaterialUsage" ADD COLUMN "producedQty" DOUBLE PRECISION;

UPDATE "MaterialUsage" m
   SET "units" = COALESCE(
         m."unitsOverride",
         (SELECT COALESCE(SUM(o."planQty"), 0) FROM "MasterOrder" o
           WHERE (m."mo" <> '' AND o."mo" = m."mo")
              OR (m."mo" = ''  AND o."bom" = m."bom")),
         0);

UPDATE "MaterialUsage" SET "sheetsPerUnit" = 0 WHERE "sheetsPerUnit" IS NULL;
ALTER TABLE "MaterialUsage" ALTER COLUMN "sheetsPerUnit" SET NOT NULL;
ALTER TABLE "MaterialUsage" ALTER COLUMN "sheetsUsed" DROP NOT NULL;

DROP INDEX IF EXISTS "MaterialUsage_workedAt_idx";
ALTER TABLE "MaterialUsage" DROP COLUMN "unitsOverride";
ALTER TABLE "MaterialUsage" DROP COLUMN "workedAt";

DROP INDEX IF EXISTS "MaterialUsage_bom_mo_material_thicknessMm_sheetSize_key";
CREATE UNIQUE INDEX "MaterialUsage_month_bom_mo_material_thicknessMm_sheetSize_key"
    ON "MaterialUsage"("month", "bom", "mo", "material", "thicknessMm", "sheetSize");
CREATE INDEX "MaterialUsage_month_idx" ON "MaterialUsage"("month");
