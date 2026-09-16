-- The plant's second product: LV panels, planned from their own monthly
-- sheet and shown apart from the transformers on every screen. Every order
-- the registry already holds is a transformer, which the default says.
ALTER TABLE "MasterOrder"
  ADD COLUMN IF NOT EXISTS "line" TEXT NOT NULL DEFAULT 'TR',
  ADD COLUMN IF NOT EXISTS "product" TEXT,
  ADD COLUMN IF NOT EXISTS "ospEncloser" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "materialsRemarks" TEXT;

CREATE INDEX IF NOT EXISTS "MasterOrder_line_idx" ON "MasterOrder"("line");
