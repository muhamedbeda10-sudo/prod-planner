-- FABRICATION: a sheet job may be typed, shared over machines and closed in
-- part of a sheet (2.5 sheets). The counts widen from whole numbers to
-- double precision; every row keeps its value (a whole number is held
-- exactly), and nothing else changes.

-- AlterTable
ALTER TABLE "ManualJob" ALTER COLUMN "qty" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "doneQty" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "WorklistMachine" ALTER COLUMN "qty" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "SheetCutLog" ALTER COLUMN "qty" SET DATA TYPE DOUBLE PRECISION;
