-- The clerk's ✓ "recorded on Odoo" — a born row waits for it before the planner's Done
ALTER TABLE "OdooEntry" ADD COLUMN IF NOT EXISTS "checkedAt" TIMESTAMP(3);
ALTER TABLE "OdooEntry" ADD COLUMN IF NOT EXISTS "checkedBy" TEXT;
-- born rows whose MO a person already typed were handled by the clerk: they
-- stay where they are, waiting for the planner's Done
UPDATE "OdooEntry" SET "checkedAt" = "updatedAt", "checkedBy" = "recordedBy"
WHERE "source" IN ('painting', 'shotblast') AND "odooMo" <> '' AND "autoMo" = false AND "checkedAt" IS NULL;
