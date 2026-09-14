-- The nesting sheet's "Actual Nesting for one Unit" is now kept as the sheet
-- writes it, instead of being recovered by dividing the job's sheets by the
-- units. Existing rows are back-filled with that same division so nothing on
-- screen moves; a re-import replaces each with the sheet's own figure.
ALTER TABLE "MaterialUsage" ADD COLUMN IF NOT EXISTS "actualPerUnit" DOUBLE PRECISION;

UPDATE "MaterialUsage"
   SET "actualPerUnit" = "sheetsUsed" / "units"
 WHERE "actualPerUnit" IS NULL
   AND "sheetsUsed" IS NOT NULL
   AND "units" > 0;
