-- The newer material sheet's own columns: SOI, one sheet's weight, utilization
ALTER TABLE "MaterialUsage" ADD COLUMN IF NOT EXISTS "soi" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MaterialUsage" ADD COLUMN IF NOT EXISTS "weightKg" DOUBLE PRECISION;
ALTER TABLE "MaterialUsage" ADD COLUMN IF NOT EXISTS "utilization" DOUBLE PRECISION;
