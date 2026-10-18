-- FABRICATION: a sheet job's part may be typed without its count of pieces.
-- Only the constraint is relaxed; every row keeps its value.

-- AlterTable
ALTER TABLE "ManualJobPart" ALTER COLUMN "pcs" DROP NOT NULL;
