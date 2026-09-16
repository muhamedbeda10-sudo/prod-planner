-- The Odoo close-out log and the material nesting tab show one product line
-- at a time, like the orders. Every row either holds today is a
-- transformer's, which the default says.
ALTER TABLE "OdooEntry" ADD COLUMN IF NOT EXISTS "line" TEXT NOT NULL DEFAULT 'TR';
ALTER TABLE "MaterialUsage" ADD COLUMN IF NOT EXISTS "line" TEXT NOT NULL DEFAULT 'TR';
CREATE INDEX IF NOT EXISTS "OdooEntry_line_idx" ON "OdooEntry"("line");
CREATE INDEX IF NOT EXISTS "MaterialUsage_line_idx" ON "MaterialUsage"("line");
