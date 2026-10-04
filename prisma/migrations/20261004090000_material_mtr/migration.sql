-- The newest nesting sheet opens with "MTR Request #" — additive, safe to deploy.
ALTER TABLE "MaterialUsage" ADD COLUMN IF NOT EXISTS "mtr" TEXT NOT NULL DEFAULT '';
