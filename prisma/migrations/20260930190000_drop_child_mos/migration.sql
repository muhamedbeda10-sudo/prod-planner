-- Back to the old ODOO flow: no child MOs, no clerk's check. The data is kept
-- in the backup schema before it goes.
CREATE SCHEMA IF NOT EXISTS backup;
CREATE TABLE IF NOT EXISTS backup.child_mo_20260930 AS SELECT * FROM "ChildMo";
CREATE TABLE IF NOT EXISTS backup.odoo_checks_20260930 AS
  SELECT "id", "odooMo", "autoMo", "checkedAt", "checkedBy" FROM "OdooEntry" WHERE "autoMo" OR "checkedAt" IS NOT NULL;

-- rows whose MO the plan filled and nobody has worked yet wait for the clerk's MO again
UPDATE "OdooEntry" e SET "odooMo" = ''
WHERE e."autoMo" AND e."status" = 'MO to be close' AND e."checkedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "OdooNote" n WHERE n."entryId" = e."id");

DROP TABLE IF EXISTS "ChildMo";
ALTER TABLE "OdooEntry" DROP COLUMN IF EXISTS "autoMo";
ALTER TABLE "OdooEntry" DROP COLUMN IF EXISTS "checkedAt";
ALTER TABLE "OdooEntry" DROP COLUMN IF EXISTS "checkedBy";
