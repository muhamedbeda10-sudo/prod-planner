-- A nest run's cutting time: one figure for identical sheets, one per sheet otherwise.
ALTER TABLE "NestRun" ADD COLUMN "identical" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "NestRun" ADD COLUMN "sheetMinutes" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[];
