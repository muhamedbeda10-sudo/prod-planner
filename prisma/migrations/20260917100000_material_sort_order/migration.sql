-- The sheet's own row order, kept through the import so the tab reads like
-- the sheet. Existing lines keep 0 and fall back to insertion order.
ALTER TABLE "MaterialUsage" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
